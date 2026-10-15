// CMSIS-DAP v2 (WebUSB bulk) probe backend.
// Command reference: https://arm-software.github.io/CMSIS_5/DAP/html/group__DAP__Commands__gr.html
import { ProbeError, type Ack, type Op, type Probe } from './types';

export const CMSISDAP_USB_FILTERS: USBDeviceFilter[] = [
  { classCode: 0xff }, // matches devices with a vendor-class interface (CMSIS-DAP v2)
  { vendorId: 0x303a, productId: 0x1002 }, // Espressif esp-usb-bridge
];

const DAP_INFO = 0x00;
const DAP_CONNECT = 0x02;
const DAP_TRANSFER_CONFIGURE = 0x04;
const DAP_TRANSFER = 0x05;
const DAP_TRANSFER_BLOCK = 0x06;
const DAP_SWJ_PINS = 0x10;
const DAP_SWJ_CLOCK = 0x11;
const DAP_SWJ_SEQUENCE = 0x12;
const DAP_SWD_CONFIGURE = 0x13;
const PIN_NRESET = 0x80;
const MIN_BLOCK_RUN = 4; // runs at least this long of one register use DAP_TransferBlock

const ACKS: Record<number, Ack> = { 2: 'WAIT', 4: 'FAULT', 7: 'NO_ACK' };

function req(op: Op): number {
  return (op.ap ? 1 : 0) | (op.write ? 0 : 2) | (op.reg & 0xc);
}

function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function checkAck(ack: number, opIndex: number): void {
  if (ack === 1) return;
  const kind: Ack = ack & 0x8 ? 'PARITY' : (ACKS[ack & 7] ?? 'NO_ACK');
  throw new ProbeError(`SWD transfer failed: ${kind} at op ${opIndex}`, kind, opIndex);
}

export class CmsisDapProbe implements Probe {
  name: string;
  private iface = -1;
  private epIn = 0;
  private epOut = 0;
  private packetSize = 64;

  constructor(readonly device: USBDevice) {
    this.name = `CMSIS-DAP v2: ${device.productName ?? 'unknown'}`;
  }

  async open(): Promise<void> {
    const d = this.device;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    const vendor = d.configuration!.interfaces.flatMap((i) =>
      i.alternates
        .filter((a) => a.interfaceClass === 0xff)
        .map((alt) => ({
          i,
          alt,
          in: alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in'),
          out: alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out'),
        })),
    ).filter((v) => v.in && v.out);
    // Spec says the interface string contains "CMSIS-DAP"; fall back for probes that only name the device.
    const pick =
      vendor.find((v) => v.alt.interfaceName?.includes('CMSIS-DAP')) ??
      (d.productName?.includes('CMSIS-DAP') || (d.vendorId === 0x303a && d.productId === 0x1002) ? vendor[0] : undefined);
    if (!pick) throw new Error(`${d.productName ?? 'Device'} has no CMSIS-DAP v2 (bulk) interface`);
    this.iface = pick.i.interfaceNumber;
    this.epIn = pick.in!.endpointNumber;
    this.epOut = pick.out!.endpointNumber;
    this.packetSize = pick.in!.packetSize;
    await d.claimInterface(this.iface);
    if (pick.i.alternates.length > 1) await d.selectAlternateInterface(this.iface, pick.alt.alternateSetting);

    const info = await this.command([DAP_INFO, 0xff]);
    if (info[1] === 2) this.packetSize = info[2] | (info[3] << 8);
  }

  /** Send one command packet, return its response (first byte checked). */
  private async command(bytes: number[]): Promise<Uint8Array> {
    if (bytes.length > this.packetSize) throw new Error(`DAP packet too large (${bytes.length})`);
    await this.device.transferOut(this.epOut, new Uint8Array(bytes));
    const r = await this.device.transferIn(this.epIn, Math.max(this.packetSize, 64));
    const data = new Uint8Array(r.data!.buffer, r.data!.byteOffset, r.data!.byteLength);
    if (data[0] !== bytes[0]) throw new Error(`DAP response 0x${data[0]?.toString(16)} to command 0x${bytes[0].toString(16)}`);
    return data;
  }

  private async commandOk(bytes: number[], what: string): Promise<void> {
    if ((await this.command(bytes))[1] !== 0) throw new Error(`${what} failed`);
  }

  async connect(clockHz = 1_000_000): Promise<number> {
    if ((await this.command([DAP_CONNECT, 1]))[1] !== 1) throw new Error('DAP_Connect (SWD) failed');
    await this.commandOk([DAP_SWJ_CLOCK, ...le32(clockHz)], 'DAP_SWJ_Clock');
    await this.commandOk([DAP_TRANSFER_CONFIGURE, 0, 0xff, 0xff, 0, 0], 'DAP_TransferConfigure'); // 65535 WAIT retries
    await this.commandOk([DAP_SWD_CONFIGURE, 0], 'DAP_SWD_Configure');
    // line reset, JTAG-to-SWD (0xE79E), line reset, idle
    const ones = Array(7).fill(0xff);
    await this.commandOk([DAP_SWJ_SEQUENCE, 136, ...ones, 0x9e, 0xe7, ...ones, 0x00], 'DAP_SWJ_Sequence');
    const [dpidr] = await this.transfer([{ ap: false, reg: 0x0 }]);
    await this.transfer([
      { ap: false, reg: 0x0, write: true, value: 0x1e }, // ABORT: clear sticky errors
      { ap: false, reg: 0x8, write: true, value: 0 }, // SELECT: DP bank 0
      { ap: false, reg: 0x4, write: true, value: 0x50000000 }, // CSYSPWRUPREQ | CDBGPWRUPREQ
    ]);
    for (let i = 0; ; i++) {
      const [ctrl] = await this.transfer([{ ap: false, reg: 0x4 }]);
      if ((ctrl & 0xa0000000) >>> 0 === 0xa0000000) break;
      if (i > 100) throw new Error(`Debug power-up not acknowledged (CTRL/STAT 0x${(ctrl >>> 0).toString(16)})`);
    }
    return dpidr >>> 0;
  }

  async transfer(ops: Op[]): Promise<number[]> {
    const out: number[] = [];
    const same = (a: Op, b: Op) => a.ap === b.ap && a.reg === b.reg && !!a.write === !!b.write;
    const runLen = (i: number) => {
      let n = 1;
      while (i + n < ops.length && n < MIN_BLOCK_RUN && same(ops[i], ops[i + n])) n++;
      return n;
    };
    for (let i = 0; i < ops.length; ) {
      if (runLen(i) >= MIN_BLOCK_RUN) {
        let n = 1;
        while (i + n < ops.length && same(ops[i], ops[i + n])) n++;
        await this.block(ops, i, n, out);
        i += n;
        continue;
      }
      // Pack a DAP_Transfer: request and response must each fit one packet.
      const pkt = [DAP_TRANSFER, 0, 0];
      let respLen = 3;
      let j = i;
      while (j < ops.length && j - i < 255) {
        if (j > i && runLen(j) >= MIN_BLOCK_RUN) break;
        const op = ops[j];
        if (pkt.length + (op.write ? 5 : 1) > this.packetSize || respLen + (op.write ? 0 : 4) > this.packetSize) break;
        pkt.push(req(op));
        if (op.write) pkt.push(...le32(op.value));
        else respLen += 4;
        j++;
      }
      pkt[2] = j - i;
      const r = await this.command(pkt);
      if (r[1] !== j - i || r[2] !== 1) checkAck(r[2] === 1 ? 7 : r[2], i + r[1]);
      const dv = new DataView(r.buffer, r.byteOffset);
      for (let k = 0; k < (respLen - 3) / 4; k++) out.push(dv.getUint32(3 + k * 4, true));
      i = j;
    }
    return out;
  }

  /** `n` same-register ops starting at `i` via DAP_TransferBlock. */
  private async block(ops: Op[], i: number, n: number, out: number[]) {
    const write = !!ops[i].write;
    const per = Math.floor((this.packetSize - (write ? 5 : 4)) / 4);
    for (let done = 0; done < n; ) {
      const cnt = Math.min(per, n - done);
      const pkt = [DAP_TRANSFER_BLOCK, 0, cnt & 0xff, cnt >> 8, req(ops[i])];
      if (write) for (let k = 0; k < cnt; k++) pkt.push(...le32((ops[i + done + k] as { value: number }).value));
      const r = await this.command(pkt);
      const got = r[1] | (r[2] << 8);
      if (got !== cnt || r[3] !== 1) checkAck(r[3] === 1 ? 7 : r[3], i + done + got);
      if (!write) {
        const dv = new DataView(r.buffer, r.byteOffset);
        for (let k = 0; k < cnt; k++) out.push(dv.getUint32(4 + k * 4, true));
      }
      done += cnt;
    }
  }

  async setReset(asserted: boolean): Promise<void> {
    await this.command([DAP_SWJ_PINS, asserted ? 0 : PIN_NRESET, PIN_NRESET, ...le32(0)]);
  }

  async close(): Promise<void> {
    try {
      if (this.iface >= 0) await this.device.releaseInterface(this.iface);
    } catch {
      // already released or unplugged
    }
    this.iface = -1;
    if (this.device.opened) await this.device.close().catch(() => {});
  }
}
