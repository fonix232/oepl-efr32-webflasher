import { describe, expect, it } from 'vitest';
import { CmsisDapProbe } from '../src/probe/cmsisdap';
import { ProbeError } from '../src/probe/types';

/** Mock USBDevice speaking enough CMSIS-DAP to answer each command; records every OUT packet. */
function mockDevice(opts: { faultAt?: number } = {}) {
  const sent: number[][] = [];
  let pending: number[] = [];
  let transferOps = 0;
  const regs = new Map<number, number>([[0x0, 0x0be12477], [0x4, 0xf0000000]]);
  const respond = (p: number[]): number[] => {
    switch (p[0]) {
      case 0x00: return [0x00, 2, 64, 0];
      case 0x02: return [0x02, 1];
      case 0x10: return [0x10, p[1]];
      case 0x05: {
        const out = [0x05, 0, 1];
        let k = 3;
        for (let n = 0; n < p[2]; n++) {
          const r = p[k++];
          if (opts.faultAt === transferOps++) { out[2] = 4; break; }
          if (r & 2) { const v = regs.get(r & 0xd) ?? 0x1234; out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24); }
          else {
            const v = (p[k] | (p[k + 1] << 8) | (p[k + 2] << 16) | (p[k + 3] << 24)) >>> 0;
            regs.set(r & 0xd, r === 0x04 ? (v | ((v & 0x50000000) << 1)) >>> 0 : v); // DP CTRL/STAT acks power-up
            k += 4;
          }
          out[1]++;
        }
        return out;
      }
      case 0x06: {
        const cnt = p[2] | (p[3] << 8);
        const out = [0x06, p[2], p[3], 1];
        if (p[4] & 2) for (let i = 0; i < cnt; i++) out.push(i, 0, 0, 0);
        return out;
      }
      default: return [p[0], 0];
    }
  };
  const dev = {
    productName: 'Test CMSIS-DAP',
    opened: false,
    configuration: {
      interfaces: [{
        interfaceNumber: 2,
        alternates: [{
          alternateSetting: 0, interfaceClass: 0xff, interfaceName: 'XYZ CMSIS-DAP v2',
          endpoints: [
            { endpointNumber: 3, direction: 'out', type: 'bulk', packetSize: 64 },
            { endpointNumber: 4, direction: 'in', type: 'bulk', packetSize: 64 },
          ],
        }],
      }],
    },
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() {},
    async claimInterface(n: number) { expect(n).toBe(2); },
    async releaseInterface() {},
    async selectAlternateInterface() {},
    async transferOut(ep: number, data: Uint8Array) {
      expect(ep).toBe(3);
      expect(data.length).toBeLessThanOrEqual(64);
      sent.push([...data]);
      pending = respond([...data]);
      return { status: 'ok', bytesWritten: data.length };
    },
    async transferIn(ep: number) {
      expect(ep).toBe(4);
      return { status: 'ok', data: new DataView(new Uint8Array(pending).buffer) };
    },
  };
  return { dev: dev as unknown as USBDevice, sent };
}

describe('CmsisDapProbe', () => {
  it('opens, connects and encodes DAP_Transfer', async () => {
    const { dev, sent } = mockDevice();
    const p = new CmsisDapProbe(dev);
    await p.open();
    expect(sent[0]).toEqual([0x00, 0xff]);
    expect(await p.connect(2_000_000)).toBe(0x0be12477);
    expect(sent).toContainEqual([0x11, 0x80, 0x84, 0x1e, 0x00]); // 2 MHz
    const seq = sent.find((s) => s[0] === 0x12)!;
    expect(seq.slice(0, 2)).toEqual([0x12, 136]);
    expect(seq.slice(9, 11)).toEqual([0x9e, 0xe7]);

    sent.length = 0;
    const r = await p.transfer([
      { ap: false, reg: 0x8, write: true, value: 0x010000f0 },
      { ap: true, reg: 0xc },
    ]);
    expect(sent).toEqual([[0x05, 0, 2, 0x08, 0xf0, 0x00, 0x00, 0x01, 0x0f]]);
    expect(r).toEqual([0x1234]);
  });

  it('uses DAP_TransferBlock for runs and splits at the packet size', async () => {
    const { dev, sent } = mockDevice();
    const p = new CmsisDapProbe(dev);
    await p.open();
    sent.length = 0;
    const writes = Array.from({ length: 20 }, (_, i) => ({ ap: true, reg: 0xc, write: true as const, value: i }));
    await p.transfer([{ ap: true, reg: 0x4, write: true, value: 0x20000000 }, ...writes]);
    expect(sent.map((s) => s[0])).toEqual([0x05, 0x06, 0x06]);
    expect(sent[1].slice(0, 5)).toEqual([0x06, 0, 14, 0, 0x0d]); // (64 - 5) / 4 = 14 words
    expect(sent[2].slice(2, 4)).toEqual([6, 0]);
    const reads = await p.transfer(Array.from({ length: 16 }, () => ({ ap: true, reg: 0xc })));
    expect(reads).toEqual([...Array.from({ length: 15 }, (_, i) => i), 0]); // 15 per packet, then 1
  });

  it('packs mixed ops within the packet size and reports FAULT with the op index', async () => {
    const { dev, sent } = mockDevice({ faultAt: 13 });
    const p = new CmsisDapProbe(dev);
    await p.open();
    sent.length = 0;
    const ops = Array.from({ length: 10 }, (_, i) => [
      { ap: true, reg: 0x8, write: true as const, value: i },
      { ap: true, reg: 0xc },
    ]).flat();
    const err = await p.transfer(ops).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect(err.ack).toBe('FAULT');
    expect(err.opIndex).toBe(13);
    for (const s of sent) expect(s.length).toBeLessThanOrEqual(64);
  });

  it('drives nRESET via DAP_SWJ_Pins', async () => {
    const { dev, sent } = mockDevice();
    const p = new CmsisDapProbe(dev);
    await p.open();
    await p.setReset(true);
    await p.setReset(false);
    expect(sent.slice(-2)).toEqual([[0x10, 0x00, 0x80, 0, 0, 0, 0], [0x10, 0x80, 0x80, 0, 0, 0, 0]]);
  });
});
