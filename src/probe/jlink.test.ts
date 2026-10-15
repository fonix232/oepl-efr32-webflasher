import { describe, expect, it } from 'vitest';
import { Bits, encodeTransfer, JLinkProbe } from './jlink';
import type { Op } from './types';

// Fake J-Link + SW-DP/MEM-AP target, decoding the HW_JTAG3 bit stream the way a real target would.
class FakeJLink {
  out: number[] = [];
  mem = new Map<number, number>();
  tar = 0;
  apPosted = 0; // value the next AP read / RDBUFF returns
  orundetect = false;
  stickyOrun = false;
  stickyErr = false;
  apAccesses = 0;
  waitAt = new Set<number>(); // AP access numbers answered with WAIT
  faultAt = new Set<number>();
  waits = 0;

  device = {
    opened: false,
    configuration: {
      interfaces: [{ interfaceNumber: 2, alternates: [{ interfaceClass: 0xff, interfaceSubclass: 0xff, interfaceProtocol: 0xff,
        endpoints: [{ type: 'bulk', direction: 'in', endpointNumber: 3, packetSize: 64 }, { type: 'bulk', direction: 'out', endpointNumber: 3, packetSize: 64 }] }] }],
    },
    open: async () => {}, close: async () => {}, claimInterface: async () => {}, releaseInterface: async () => {},
    transferOut: async (_ep: number, data: Uint8Array) => {
      this.out.push(...this.handle(data));
      return { status: 'ok', bytesWritten: data.length };
    },
    transferIn: async (_ep: number, len: number) => {
      const chunk = new Uint8Array(this.out.splice(0, Math.min(len, 64)));
      return { status: 'ok', data: new DataView(chunk.buffer) };
    },
  };

  private handle(c: Uint8Array): number[] {
    const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
    switch (c[0]) {
      case 0x01: return [4, 0, ...new TextEncoder().encode('FAKE')];
      case 0xe8: return u32(1 << 17);
      case 0xc7: return u32(c[1] === 0xff ? 2 : 0);
      case 0xcf: return this.swd(c);
      default: return [];
    }
  }

  private swd(c: Uint8Array): number[] {
    const n = c[2] | (c[3] << 8);
    const nb = (n + 7) >> 3;
    const bit = (k: number) => (c[4 + nb + (k >> 3)] >> (k & 7)) & 1;
    const cap = new Array<number>(n).fill(1);
    const drive = (pos: number, v: number, count: number) => { for (let k = 0; k < count; k++) cap[pos + k] = (v >>> k) & 1; };
    let p = 0;
    while (p < n) {
      if (!bit(p)) { cap[p] = 0; p++; continue; }
      const h = Array.from({ length: 8 }, (_, k) => bit(p + k));
      expect(h[0] ^ h[1] ^ h[2] ^ h[3] ^ h[4] ^ h[5]).toBe(1); // start + parity
      expect([h[6], h[7]]).toEqual([0, 1]);
      drive(p, 0xff, 8); // host-driven bits echo
      const [ap, rnw, reg] = [h[1], h[2], (h[3] << 2) | (h[4] << 3)];
      const data = Array.from({ length: 32 }, (_, k) => bit(p + 13 + k)).reduce((a, b, k) => a | (b << k), 0) >>> 0;
      const ack = this.access(!!ap, !!rnw, reg, data);
      // a real J-Link returns target-driven bits one position early (seen on the Si-DBG1015A)
      drive(p + 8, ack.ack, 3);
      if (rnw) drive(p + 11, ack.value, 32), drive(p + 43, popcount(ack.value) & 1, 1);
      p += 46;
    }
    const bytes = new Array<number>(nb).fill(0);
    cap.forEach((b, k) => (bytes[k >> 3] |= b << (k & 7)));
    return [...bytes, 0];
  }

  private access(ap: boolean, rnw: boolean, reg: number, data: number): { ack: number; value: number } {
    const exempt = !ap && ((rnw && reg <= 4) || (!rnw && reg === 0));
    if (this.stickyOrun && !exempt) return { ack: 4, value: 0 };
    if (ap) {
      const k = this.apAccesses++;
      if (this.faultAt.has(k)) { this.stickyErr = this.stickyOrun = true; return { ack: 4, value: 0 }; }
      if (this.waitAt.has(k)) { this.waits++; this.stickyOrun = this.orundetect; return { ack: 2, value: 0 }; }
      const prev = this.apPosted;
      if (reg === 0x4) rnw ? (this.apPosted = this.tar) : (this.tar = data);
      if (reg === 0xc) {
        if (rnw) this.apPosted = this.mem.get(this.tar) ?? 0;
        else this.mem.set(this.tar, data);
        this.tar += 4;
      }
      return { ack: 1, value: prev };
    }
    if (!rnw && reg === 0) { if (data & 0x10) this.stickyOrun = false; if (data & 0x4) this.stickyErr = false; }
    if (!rnw && reg === 4) this.orundetect = !!(data & 1);
    if (rnw && reg === 0xc) return { ack: 1, value: this.apPosted };
    if (rnw && reg === 0) return { ack: 1, value: 0x6ba02477 };
    return { ack: 1, value: 0 };
  }
}

const popcount = (v: number) => v.toString(2).split('1').length - 1;

async function setup(maxBits = 65535) {
  const fake = new FakeJLink();
  const probe = new JLinkProbe(fake.device as unknown as USBDevice);
  await probe.open();
  (probe as unknown as { maxBits: number }).maxBits = maxBits;
  await probe.transfer([{ ap: false, reg: 4, write: true, value: 0x50000000 }]); // turns ORUNDETECT on
  return { fake, probe };
}

const writeOps = (addr: number, words: number[]): Op[] => [
  { ap: true, reg: 0x4, write: true, value: addr },
  ...words.map((value): Op => ({ ap: true, reg: 0xc, write: true, value })),
];
const readOps = (addr: number, n: number): Op[] => [{ ap: true, reg: 0x4, write: true, value: addr }, ...Array.from({ length: n }, (): Op => ({ ap: true, reg: 0xc }))];

describe('JLinkProbe', () => {
  it('encodes the textbook SWD request bytes', () => {
    const hdr = (ap: boolean, write: boolean, reg: number) => { const b = new Bits(); encodeTransfer(b, ap, write, reg, 0); return b.val[0]; };
    expect(hdr(false, false, 0)).toBe(0xa5); // DPIDR read
    expect(hdr(true, false, 0xc)).toBe(0x9f); // DRW read
    expect(hdr(false, true, 0)).toBe(0x81); // ABORT write
  });

  it('opens and reads firmware', async () => {
    const { probe } = await setup();
    expect(probe.firmware).toBe('FAKE');
  });

  it('hides posted AP reads, across chunks, with WAIT retries mid-batch', async () => {
    const { fake, probe } = await setup(300);
    const words = Array.from({ length: 20 }, (_, k) => (k * 0x01010101) >>> 0);
    fake.waitAt = new Set([5, 30]); // one WAIT during the writes, one during the reads
    await probe.transfer(writeOps(0x20000000, words));
    const got = await probe.transfer([{ ap: false, reg: 0 }, ...readOps(0x20000000, 20), { ap: false, reg: 4 }]);
    expect(fake.waits).toBe(2);
    expect(got[0]).toBe(0x6ba02477);
    expect(got.slice(1, 21)).toEqual(words);
    expect(got).toHaveLength(22);
    expect([...fake.mem.keys()]).toHaveLength(20);
  });

  it('throws FAULT with the failing op index and leaves later ops unexecuted', async () => {
    const { fake, probe } = await setup();
    fake.faultAt = new Set([3]);
    await expect(probe.transfer(writeOps(0x20000000, [1, 2, 3, 4, 5]))).rejects.toMatchObject({ ack: 'FAULT', opIndex: 3 });
    expect([...fake.mem.values()]).toEqual([1, 2]);
    expect(fake.stickyOrun).toBe(false);
    expect(fake.stickyErr).toBe(true);
  });
});
