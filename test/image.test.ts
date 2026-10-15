import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseImage, parseIntelHex, parseSrec } from '../src/image';
import { V43 } from './sim';


describe('image parsing', () => {
  it('parses the real v43 .s37 into bootloader + app segments', () => {
    const segs = parseSrec(readFileSync(V43, 'utf8'));
    expect(segs.map((s) => [s.addr, s.data.length])).toEqual([
      [0x0, 18060],
      [0x6000, 239184],
    ]);
    expect(segs[0].addr + segs[0].data.length).toBe(0x468c);
    expect(segs[1].addr + segs[1].data.length).toBe(0x40650);
  });

  it('rejects a bad checksum', () => {
    expect(() => parseSrec('S1130000000102030405060708090A0B0C0D0E0F00\n')).toThrow(/checksum/);
  });

  it('parses Intel HEX with extended linear address and merges adjacent records', () => {
    const hex = [':020000040001F9', ':0400000001020304F2', ':0400040005060708DE', ':00000001FF'].join('\n');
    const segs = parseIntelHex(hex);
    expect(segs).toHaveLength(1);
    expect(segs[0].addr).toBe(0x10000);
    expect([...segs[0].data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseImage('x.hex', hex)[0].addr).toBe(0x10000);
  });
});
