import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Adi } from '../src/adi';
import { Dci } from '../src/dci';
import { programFlash, readUserdata, resetTarget } from '../src/flash';
import { parseSrec, type Segment } from '../src/image';
import { SimProbe, V43 } from './sim';

function expectFlashed(sim: SimProbe, segs: Segment[]) {
  for (const s of segs) {
    const words = new Uint32Array(s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.length));
    words.forEach((w, i) => {
      if (sim.flashWord(s.addr + i * 4) !== w) throw new Error(`mismatch at 0x${(s.addr + i * 4).toString(16)}`);
    });
  }
}

describe('ADI MEM-AP', () => {
  it('handles 1 KB TAR wrap and SELECT caching', async () => {
    const sim = new SimProbe();
    const adi = new Adi(sim);
    await adi.connect();
    const data = Array.from({ length: 40 }, (_, i) => i * 0x01010101);
    await adi.writeBlock(0x200003c0, data); // crosses 0x20000400
    expect([...(await adi.readBlock(0x200003c0, 40))]).toEqual(data.map((v) => v >>> 0));
    expect(sim.mem.get(0x20000000)).toBeUndefined();
    expect(await adi.readAP(0x010000fc)).toBe(0x54770002);
    expect(sim.select).toBe(0x010000f0);
  });
});

describe('end to end against simulated EFR32xG22', () => {
  it('status, unlock, reset, userdata, program v43, reset', async () => {
    const sim = new SimProbe();
    sim.locked = true;
    const adi = new Adi(sim);
    await adi.connect();
    const dci = new Dci(adi);
    await dci.check();
    const st = await dci.status();
    expect(st.family).toBe('EFR32xG22');
    expect(st.debugLock).toBe(3);
    await expect(adi.read32(0x20000000)).rejects.toThrow(/locked/);

    await dci.unlockErase();
    await resetTarget(adi, false);
    await adi.connect();
    const ud = await readUserdata(adi);
    expect(ud.length).toBe(1024);
    expect(ud[4]).toBe(0x12); // word 1 = 0x11111112, little-endian

    const segs = parseSrec(readFileSync(V43, 'utf8'));
    const phases: number[] = [];
    await programFlash(adi, segs, (p) => phases.push(p.done));
    expectFlashed(sim, segs);
    // pages 0..2 (bootloader) and 3..32 (app 0x6000..0x40650)
    expect(sim.erasedPages).toEqual(Array.from({ length: 33 }, (_, i) => i * 0x2000));
    expect(Math.max(...sim.wordWrites.values())).toBe(1);
    expect(phases.at(-1)).toBe(18060 + 239184);
    await resetTarget(adi);
    expect(sim.halted).toBe(false);
  });

  it('falls back to slow writes when the MSC is not ready', async () => {
    const sim = new SimProbe();
    sim.notReadyEvery = 37;
    const adi = new Adi(sim);
    await adi.connect();
    const data = Uint8Array.from({ length: 0x3000 }, (_, i) => (i * 7) & 0xff);
    const segs = [{ addr: 0x7000, data }];
    const logs: string[] = [];
    await programFlash(adi, segs, undefined, (m) => logs.push(m));
    expectFlashed(sim, segs);
    expect(logs.some((l) => /retrying slowly/.test(l))).toBe(true);
  });

  it('refuses data outside main flash', async () => {
    const adi = new Adi(new SimProbe());
    await expect(programFlash(adi, [{ addr: 0x0fe00000, data: new Uint8Array(4) }])).rejects.toThrow(/outside main flash/);
  });
});
