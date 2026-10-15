// SEGGER J-Link backend over WebUSB (raw SWD via EMU_CMD_HW_JTAG3).
//
// USB protocol ported from probe-rs (https://github.com/probe-rs/probe-rs),
// probe-rs/src/probe/jlink/ and probe-rs/src/probe/swd/, (c) the probe-rs contributors,
// licensed MIT OR Apache-2.0.
//
// Error handling: every CTRL/STAT write gets ORUNDETECT set, so after a WAIT/FAULT the target keeps
// the data phase (bit framing stays aligned) and FAULTs every following access in the batch instead
// of decoding write data as bogus requests. We then clear STICKYORUN and resume (WAIT) or throw.

import { ProbeError, type Ack, type Op, type Probe } from './types';

export const JLINK_USB_FILTERS: USBDeviceFilter[] = [{ vendorId: 0x1366 }];

const CMD_VERSION = 0x01;
const CMD_SET_SPEED = 0x05;
const CMD_GET_STATE = 0x07;
const CMD_GET_SPEEDS = 0xc0;
const CMD_SELECT_IF = 0xc7;
const CMD_HW_JTAG3 = 0xcf;
const CMD_GET_MAX_MEM_BLOCK = 0xd4;
const CMD_HW_RESET0 = 0xdc;
const CMD_HW_RESET1 = 0xdd;
const CMD_GET_CAPS = 0xe8;

const CAP_SPEED_INFO = 1 << 9;
const CAP_GET_MAX_BLOCK_SIZE = 1 << 11;
const CAP_SELECT_IF = 1 << 17;
const IF_SWD = 1;

const DP_ABORT = 0x0; // write
const DP_DPIDR = 0x0; // read
const DP_CTRL_STAT = 0x4;
const DP_RDBUFF = 0xc;
const ORUNDETECT = 1;
const ABORT_ORUNERRCLR = 0x10;
const ABORT_CLEAR_ALL = 0x1e;
const PWRUP_REQ = 0x50000000;
const PWRUP_ACK = 0xa0000000;

const IDLE_AFTER_AP = 8; // gives the AHB-AP time to finish, so WAIT stays rare
const IDLE_AFTER_DP = 2;
const WIRE_BITS = 46 + IDLE_AFTER_AP;
const MAX_WAITS = 100;

/** SWDIO bit stream for HW_JTAG3: per bit a direction (1 = probe drives) and a value, LSB first. */
export class Bits {
  dir: number[] = [];
  val: number[] = [];
  n = 0;

  out(value: number, count: number): void {
    for (let k = 0; k < count; k++) this.bit(true, (value >>> k) & 1);
  }

  in(count: number): void {
    for (let k = 0; k < count; k++) this.bit(false, 0);
  }

  private bit(out: boolean, v: number): void {
    const i = this.n >> 3;
    const m = 1 << (this.n & 7);
    if (m === 1) {
      this.dir.push(0);
      this.val.push(0);
    }
    if (out) this.dir[i] |= m;
    if (v) this.val[i] |= m;
    this.n++;
  }
}

const parity = (v: number): number => {
  v ^= v >>> 16;
  v ^= v >>> 8;
  v ^= v >>> 4;
  v ^= v >>> 2;
  v ^= v >>> 1;
  return v & 1;
};

const bitsAt = (cap: Uint8Array, pos: number, count: number): number => {
  let v = 0;
  for (let k = 0; k < count; k++) v |= ((cap[(pos + k) >> 3] >> ((pos + k) & 7)) & 1) << k;
  return v >>> 0;
};

/** Appends one SWD transfer plus trailing idle cycles; returns the bit offset of the 3-bit ACK. */
export function encodeTransfer(b: Bits, ap: boolean, write: boolean, reg: number, value: number): number {
  const apb = +ap;
  const rnw = +!write;
  const a2 = (reg >> 2) & 1;
  const a3 = (reg >> 3) & 1;
  b.out(1 | (apb << 1) | (rnw << 2) | (a2 << 3) | (a3 << 4) | ((apb ^ rnw ^ a2 ^ a3) << 5) | (1 << 7), 8);
  b.in(1); // turnaround
  const ack = b.n;
  b.in(3);
  if (write) {
    b.in(1); // turnaround
    b.out(value >>> 0, 32);
    b.out(parity(value), 1);
  } else {
    b.in(33 + 1); // data + parity + turnaround
  }
  b.out(0, ap ? IDLE_AFTER_AP : IDLE_AFTER_DP);
  return ack;
}

const ackName = (ack: number): Ack => (ack === 2 ? 'WAIT' : ack === 4 ? 'FAULT' : 'NO_ACK');

interface Wire {
  ack: number; // bit offset of the ACK in this chunk
  slot: number; // result index this read's data fills, -1 if none
  resume: number; // op index to restart encoding from on WAIT
  pending: number; // posted AP read slot outstanding before this wire
  blame: number; // op index reported in errors
}

export class JLinkProbe implements Probe {
  name = 'J-Link';
  firmware = '';
  caps = 0;
  private iface = -1;
  private epIn = 0;
  private epOut = 0;
  private packet = 64;
  private rx = new Uint8Array(0);
  private maxBits = 65535;

  constructor(readonly device: USBDevice) {}

  async open(): Promise<void> {
    const d = this.device;
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    for (const i of d.configuration!.interfaces) {
      const a = i.alternates[0];
      const eps = a.endpoints;
      if (a.interfaceClass !== 0xff || a.interfaceSubclass !== 0xff || a.interfaceProtocol !== 0xff) continue;
      if (eps.length !== 2 || eps.some((e) => e.type !== 'bulk')) continue;
      const epIn = eps.find((e) => e.direction === 'in');
      const epOut = eps.find((e) => e.direction === 'out');
      if (!epIn || !epOut) continue;
      this.iface = i.interfaceNumber;
      this.epIn = epIn.endpointNumber;
      this.epOut = epOut.endpointNumber;
      this.packet = epIn.packetSize;
    }
    if (this.iface < 0) throw new ProbeError('Not a J-Link: no vendor-specific bulk interface (CMSIS-DAP firmware?)');
    await d.claimInterface(this.iface);

    const len = new DataView((await this.cmd([CMD_VERSION], 2)).buffer).getUint16(0, true);
    const ver = await this.read(len);
    const nul = ver.indexOf(0);
    this.firmware = new TextDecoder().decode(nul < 0 ? ver : ver.subarray(0, nul)).trim();
    this.name = `J-Link: ${d.productName ?? 'J-Link'} ${d.serialNumber ?? ''}`.trim();

    this.caps = await this.u32([CMD_GET_CAPS]);
    if (!(this.caps & CAP_SELECT_IF) || !((await this.u32([CMD_SELECT_IF, 0xff])) & (1 << IF_SWD)))
      throw new ProbeError(`J-Link without SWD support (${this.firmware})`);
    if (this.caps & CAP_GET_MAX_BLOCK_SIZE) {
      const block = await this.u32([CMD_GET_MAX_MEM_BLOCK]);
      this.maxBits = Math.min(65535, Math.floor((block - 4) / 2) * 8); // as probe-rs
    }
  }

  /** VTref in volts. */
  async getTargetVoltage(): Promise<number> {
    const s = await this.cmd([CMD_GET_STATE], 8);
    return (s[0] | (s[1] << 8)) / 1000;
  }

  /** Select SWD, set the clock, run line reset + JTAG-to-SWD and read DPIDR. No DP/AP writes. */
  async readDpidr(clockHz = 4_000_000): Promise<number> {
    await this.cmd([CMD_SELECT_IF, IF_SWD], 4);
    let khz = Math.round(clockHz / 1000);
    if (this.caps & CAP_SPEED_INFO) {
      const s = new DataView((await this.cmd([CMD_GET_SPEEDS], 6)).buffer);
      khz = Math.min(khz, Math.floor(s.getUint32(0, true) / s.getUint16(4, true) / 1000));
    }
    khz = Math.max(1, Math.min(khz, 0xfffe));
    await this.cmd([CMD_SET_SPEED, khz & 0xff, khz >> 8]);

    const b = new Bits();
    b.out(0xffffffff, 32); // line reset: >= 50 ones
    b.out(0xffffff, 24);
    b.out(0xe79e, 16); // JTAG-to-SWD
    b.out(0xffffffff, 32);
    b.out(0xffffff, 24);
    b.out(0, 8);
    const ack = encodeTransfer(b, false, false, DP_DPIDR, 0);
    const cap = await this.swdIo(b);
    const a = bitsAt(cap, ack, 3);
    if (a !== 1) throw new ProbeError(`No SWD response reading DPIDR (ACK ${ackName(a)}): is the target wired up and powered?`, ackName(a));
    const dpidr = bitsAt(cap, ack + 3, 32);
    if (parity(dpidr) !== bitsAt(cap, ack + 35, 1)) throw new ProbeError('DPIDR parity error', 'PARITY');
    return dpidr;
  }

  async connect(clockHz?: number): Promise<number> {
    const dpidr = await this.readDpidr(clockHz);
    await this.transfer([
      { ap: false, reg: DP_ABORT, write: true, value: ABORT_CLEAR_ALL },
      { ap: false, reg: DP_CTRL_STAT, write: true, value: PWRUP_REQ },
    ]);
    for (let t = 0; t < 100; t++) {
      const [s] = await this.transfer([{ ap: false, reg: DP_CTRL_STAT }]);
      if ((s & PWRUP_ACK) >>> 0 === PWRUP_ACK) return dpidr;
    }
    throw new ProbeError('Debug power-up not acknowledged (CTRL/STAT)');
  }

  async transfer(ops: Op[]): Promise<number[]> {
    const slotOf: number[] = [];
    let reads = 0;
    for (const op of ops) slotOf.push(op.write ? -1 : reads++);
    const results = new Array<number>(reads);
    let i = 0;
    let pending = -1; // result slot of the posted AP read still in flight
    let waits = 0;

    outer: while (i < ops.length || pending >= 0) {
      const b = new Bits();
      const wires: Wire[] = [];
      const emit = (ap: boolean, write: boolean, reg: number, value: number, slot: number) =>
        wires.push({ ack: encodeTransfer(b, ap, write, reg, value), slot, resume: i, pending, blame: Math.min(i, ops.length - 1) });

      while ((i < ops.length || pending >= 0) && b.n + 2 * WIRE_BITS <= this.maxBits) {
        const op = ops[i] as Op | undefined;
        if (op?.ap && !op.write) {
          emit(true, false, op.reg, 0, pending);
          pending = slotOf[i++];
          continue;
        }
        if (pending >= 0) {
          emit(false, false, DP_RDBUFF, 0, pending);
          pending = -1;
        }
        if (!op) break;
        if (op.write) {
          const value = !op.ap && op.reg === DP_CTRL_STAT ? op.value | ORUNDETECT : op.value;
          emit(op.ap, true, op.reg, value, -1);
        } else {
          emit(false, false, op.reg, 0, slotOf[i]);
        }
        i++;
        if (op.write && !op.ap && op.reg === DP_ABORT) break; // ABORT clears STICKYORUN: nothing may follow it
      }

      const cap = await this.swdIo(b);
      for (const w of wires) {
        const ack = bitsAt(cap, w.ack, 3);
        if (ack === 1) {
          if (w.slot < 0) continue;
          const v = bitsAt(cap, w.ack + 3, 32);
          if (parity(v) !== bitsAt(cap, w.ack + 35, 1)) throw new ProbeError('SWD read parity error', 'PARITY', w.blame);
          results[w.slot] = v;
          continue;
        }
        const kind = ackName(ack);
        if (kind !== 'NO_ACK') await this.clearOverrun();
        if (kind === 'WAIT' && ++waits < MAX_WAITS) {
          i = w.resume;
          pending = w.pending;
          continue outer;
        }
        throw new ProbeError(`SWD ${kind} on op ${w.blame}`, kind, w.blame);
      }
    }
    return results;
  }

  async setReset(asserted: boolean): Promise<void> {
    await this.cmd([asserted ? CMD_HW_RESET0 : CMD_HW_RESET1]);
  }

  async close(): Promise<void> {
    const d = this.device;
    if (!d.opened) return;
    if (this.iface >= 0) await d.releaseInterface(this.iface).catch(() => {});
    await d.close();
  }

  private async clearOverrun(): Promise<void> {
    const b = new Bits();
    const ack = encodeTransfer(b, false, true, DP_ABORT, ABORT_ORUNERRCLR);
    const a = bitsAt(await this.swdIo(b), ack, 3);
    if (a !== 1) throw new ProbeError(`SWD ${ackName(a)} clearing STICKYORUN`, ackName(a));
  }

  private async swdIo(b: Bits): Promise<Uint8Array> {
    const nb = b.dir.length;
    const resp = await this.cmd([CMD_HW_JTAG3, 0, b.n & 0xff, b.n >> 8, ...b.dir, ...b.val], nb + 1);
    if (resp[nb] !== 0) throw new ProbeError(`J-Link HW_JTAG3 error 0x${resp[nb].toString(16)}`);
    return resp;
  }

  private async u32(bytes: number[]): Promise<number> {
    return new DataView((await this.cmd(bytes, 4)).buffer).getUint32(0, true);
  }

  private async cmd(bytes: number[], respLen = 0): Promise<Uint8Array> {
    const r = await this.device.transferOut(this.epOut, new Uint8Array(bytes));
    if (r.status !== 'ok' || r.bytesWritten !== bytes.length) throw new ProbeError(`J-Link USB write failed (${r.status})`);
    return respLen ? this.read(respLen) : new Uint8Array(0);
  }

  // Reads are always whole packets (no libusb overflow); surplus bytes are kept for the next read.
  private async read(n: number): Promise<Uint8Array> {
    while (this.rx.length < n) {
      const r = await this.device.transferIn(this.epIn, Math.ceil((n - this.rx.length) / this.packet) * this.packet);
      if (r.status !== 'ok' || !r.data) throw new ProbeError(`J-Link USB read failed (${r.status})`);
      const next = new Uint8Array(this.rx.length + r.data.byteLength);
      next.set(this.rx);
      next.set(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength), this.rx.length);
      this.rx = next;
    }
    const out = this.rx.slice(0, n);
    this.rx = this.rx.slice(n);
    return out;
  }
}
