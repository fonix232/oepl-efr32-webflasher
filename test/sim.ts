// In-memory EFR32xG22 simulator behind the Probe contract: DP, MEM-AP (AP0) with 1 KB TAR wrap
// and banked data registers, MSC flash controller, DHCSR, and the DCI on AP1.
import { resolve } from 'node:path';
import { ProbeError, type Op, type Probe } from '../src/probe/types';

const MSC = 0x40030000;
/** Real firmware image from the Tag_FW_EFR32xG22 checkout ($FIRMWARE_REPO or ../Tag_FW_EFR32xG22). */
export const V43 = resolve(__dirname, '..', process.env.FIRMWARE_REPO ?? '../Tag_FW_EFR32xG22', 'full_binaries/v43/SOLUM_AUTODETECT_FULL_v43.s37');
export const SIM_DPIDR = 0x0be12477;

export class SimProbe implements Probe {
  name = 'sim';
  select = 0xdeadbeef; // garbage: SELECT survives line resets, ADI must not assume a value
  csw = 0x23000040;
  tar = 0;
  mem = new Map<number, number>();
  locked = false;
  halted = false;
  erasedPages: number[] = [];
  resets = 0;
  wordWrites = new Map<number, number>();
  /** Every Nth WDATA write leaves WDATAREADY clear until STATUS is read once (0 = never). */
  notReadyEvery = 0;
  transfers = 0;

  private msc = { lock: true, wren: false, addrb: 0, ready: true, writes: 0 };
  private dciIn: number[] = [];
  private dciOut: number[] = [];
  private dciTar = 0;

  constructor() {
    for (let i = 0; i < 0x100; i++) this.mem.set(0x0fe00000 + i * 4, (0x11111111 * (i & 0xf) + i) >>> 0);
  }

  async open() {}
  async close() {}
  async connect() {
    return SIM_DPIDR;
  }
  async setReset(asserted: boolean) {
    if (!asserted) {
      this.resets++;
      this.halted = false;
    }
  }

  flashWord(addr: number) {
    return this.mem.get(addr) ?? 0xffffffff;
  }

  async transfer(ops: Op[]): Promise<number[]> {
    this.transfers++;
    const out: number[] = [];
    ops.forEach((op, i) => {
      const v = op.ap ? this.apAccess(op, i) : this.dpAccess(op);
      if (!op.write) out.push(v >>> 0);
    });
    return out;
  }

  private dpAccess(op: Op): number {
    if (op.write) {
      if (op.reg === 0x8) this.select = op.value >>> 0;
      return 0;
    }
    return op.reg === 0x0 ? SIM_DPIDR : op.reg === 0x4 ? 0xf0000000 : 0;
  }

  private apAccess(op: Op, index: number): number {
    const apsel = this.select >>> 24;
    const addr = (this.select & 0xf0) | op.reg;
    const val = op.write ? op.value >>> 0 : undefined;
    if (apsel === 1) return this.dci(addr, val);
    if (apsel !== 0) throw new ProbeError(`no AP${apsel}`, 'FAULT', index);
    if (this.locked && addr !== 0xfc) throw new ProbeError('AP0 locked', 'FAULT', index);
    switch (addr) {
      case 0x00:
        if (val !== undefined) this.csw = val;
        return this.csw;
      case 0x04:
        if (val !== undefined) this.tar = val;
        return this.tar;
      case 0x0c: {
        if ((this.csw & 0x37) !== 0x12) throw new Error(`CSW not set up for 32-bit auto-increment: 0x${this.csw.toString(16)}`);
        const r = this.bus(this.tar, val);
        this.tar = ((this.tar & ~0x3ff) | ((this.tar + 4) & 0x3ff)) >>> 0; // 1 KB wrap
        return r;
      }
      case 0x10: case 0x14: case 0x18: case 0x1c:
        return this.bus(((this.tar & ~0xf) | (addr & 0xc)) >>> 0, val);
      case 0xfc:
        return 0x84770001;
    }
    throw new ProbeError(`AP0 reg 0x${addr.toString(16)}`, 'FAULT', index);
  }

  private bus(a: number, val?: number): number {
    if (a >= MSC && a < MSC + 0x100) return this.mscAccess(a - MSC, val);
    if (a === 0xe000edf0) {
      if (val !== undefined && val >>> 16 === 0xa05f) this.halted = (val & 3) === 3;
      return (this.halted ? 1 << 17 : 0) | 1;
    }
    if (a === 0xe000ed0c) {
      if (val === 0x05fa0004) this.resets++;
      return 0;
    }
    if (a < 0x80000 && val !== undefined) throw new Error(`Direct bus write to flash 0x${a.toString(16)}`);
    if (val !== undefined) this.mem.set(a, val);
    return this.mem.get(a) ?? (a < 0x80000 ? 0xffffffff : 0);
  }

  private mscAccess(off: number, val?: number): number {
    const m = this.msc;
    if (val === undefined) {
      if (off === 0x1c) {
        const st = (m.ready ? 1 << 3 : 0) | (m.lock ? 1 << 1 : 0) | (m.addrb >= 0x80000 ? 1 << 2 : 0);
        m.ready = true;
        return st;
      }
      if (off === 0x0c) return m.wren ? 1 : 0;
      return 0;
    }
    switch (off) {
      case 0x3c: m.lock = val !== 0x1b71; break;
      case 0x0c: m.wren = (val & 1) === 1; break;
      case 0x14: m.addrb = val; break;
      case 0x10:
        if (val & 2) {
          if (m.lock || !m.wren) throw new Error('erase while MSC locked / WREN clear');
          const page = m.addrb & ~0x1fff;
          for (let a = page; a < page + 0x2000; a += 4) { this.mem.delete(a); this.wordWrites.delete(a); }
          this.erasedPages.push(page);
        }
        break;
      case 0x18: {
        if (m.lock || !m.wren) throw new Error('WDATA while MSC locked / WREN clear');
        if (!this.halted) throw new Error('flash write with core running');
        if (m.ready) {
          this.mem.set(m.addrb, (this.flashWord(m.addrb) & val) >>> 0);
          this.wordWrites.set(m.addrb, (this.wordWrites.get(m.addrb) ?? 0) + 1);
        } // else: write dropped, like real hardware may
        m.addrb += 4;
        m.writes++;
        m.ready = !(this.notReadyEvery && m.writes % this.notReadyEvery === 0);
        break;
      }
    }
    return 0;
  }

  // DCI on AP1: TAR selects 0x1000 write FIFO, 0x1004 read FIFO, 0x1008 status.
  private dci(addr: number, val?: number): number {
    if (addr === 0xfc) return 0x54770002;
    if (addr === 0x04) {
      if (val !== undefined) this.dciTar = val;
      return this.dciTar;
    }
    if (addr !== 0x0c) return 0;
    if (this.dciTar === 0x1008) return this.dciOut.length ? 0x100 : 0;
    if (this.dciTar === 0x1004) return this.dciOut.shift() ?? 0;
    if (this.dciTar === 0x1000 && val !== undefined) {
      this.dciIn.push(val);
      if (this.dciIn.length * 4 === this.dciIn[0]) this.dciExec(this.dciIn.splice(0));
    }
    return 0;
  }

  private dciExec([, cmd]: number[]) {
    let rsp: number[] = [];
    if (cmd === 0xfe010000) rsp = [0, 0x0105_0a0b, 0, this.locked ? 3 : 0, 0];
    else if (cmd === 0x430f0000) {
      this.locked = false;
      for (const a of [...this.mem.keys()]) if (a < 0x80000) this.mem.delete(a);
    }
    this.dciOut.push(((rsp.length + 1) * 4) >>> 0, ...rsp);
  }
}
