// ARM Debug Interface on top of a raw Probe: DP SELECT caching, pyOCD-style AP addressing
// (APSEL << 24 | bank | reg) and MEM-AP (AP0) word access with TAR auto-increment.
import type { Op, Probe } from './probe/types';

const DP_ABORT = 0x0;
const DP_SELECT = 0x8;
export const AP_CSW = 0x00;
export const AP_TAR = 0x04;
export const AP_DRW = 0x0c;
export const AP_IDR = 0xfc;
const TAR_WRAP = 0x400; // auto-increment is only guaranteed within 1 KB
const CHUNK_WORDS = 256;

export class Adi {
  private select?: number;
  private cswReady = false;

  constructor(readonly probe: Probe) {}

  /** (Re)connect SWD; drops all cached state since SELECT/CSW survive a line reset unpredictably. */
  async connect(clockHz?: number): Promise<number> {
    this.invalidate();
    return this.probe.connect(clockHz);
  }

  private invalidate() {
    this.select = undefined;
    this.cswReady = false;
  }

  /** Ops for one AP access at pyOCD address `addr`; prepends a SELECT write when the cache misses. */
  ap(addr: number, value?: number): Op[] {
    const sel = (addr & 0xff0000f0) >>> 0;
    const ops: Op[] = [];
    if (sel !== this.select) {
      ops.push({ ap: false, reg: DP_SELECT, write: true, value: sel });
      this.select = sel;
    }
    const reg = addr & 0xc;
    ops.push(value === undefined ? { ap: true, reg } : { ap: true, reg, write: true, value: value >>> 0 });
    return ops;
  }

  async run(ops: Op[]): Promise<number[]> {
    try {
      return (await this.probe.transfer(ops)).map((v) => v >>> 0);
    } catch (e) {
      this.invalidate(); // we don't know which SELECT/CSW writes landed
      throw e;
    }
  }

  async readAP(addr: number): Promise<number> {
    return (await this.run(this.ap(addr)))[0];
  }

  async writeAP(addr: number, value: number): Promise<void> {
    await this.run(this.ap(addr, value));
  }

  /** Clear sticky DP errors after a FAULT. */
  async clearErrors(): Promise<void> {
    await this.probe.transfer([{ ap: false, reg: DP_ABORT, write: true, value: 0x1e }]);
  }

  /** MEM-AP AP0 setup: 32-bit accesses, single auto-increment, secure (keep other CSW bits). */
  async memOps(): Promise<Op[]> {
    if (this.cswReady) return [];
    const csw = await this.readAP(AP_CSW);
    this.cswReady = true;
    // bit 30 cleared = secure transfer, needed for the MSC_S / CMU_S peripheral aliases.
    return this.ap(AP_CSW, ((csw & 0xbffff000) | 0x12) >>> 0);
  }

  async read32(addr: number): Promise<number> {
    return (await this.readBlock(addr, 1))[0];
  }

  async write32(addr: number, value: number): Promise<void> {
    await this.writeBlock(addr, [value]);
  }

  async readBlock(addr: number, words: number): Promise<Uint32Array> {
    const out = new Uint32Array(words);
    for (let i = 0; i < words; ) {
      const a = addr + i * 4;
      const n = Math.min(words - i, (TAR_WRAP - (a % TAR_WRAP)) / 4, CHUNK_WORDS);
      const ops = [...(await this.memOps()), ...this.ap(AP_TAR, a)];
      for (let k = 0; k < n; k++) ops.push(...this.ap(AP_DRW));
      out.set(await this.run(ops), i);
      i += n;
    }
    return out;
  }

  async writeBlock(addr: number, data: ArrayLike<number>): Promise<void> {
    for (let i = 0; i < data.length; ) {
      const a = addr + i * 4;
      const n = Math.min(data.length - i, (TAR_WRAP - (a % TAR_WRAP)) / 4, CHUNK_WORDS);
      const ops = [...(await this.memOps()), ...this.ap(AP_TAR, a)];
      for (let k = 0; k < n; k++) ops.push(...this.ap(AP_DRW, data[i + k]));
      await this.run(ops);
      i += n;
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
