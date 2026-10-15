// Firmware image parsing: Motorola S-record (.s37) and Intel HEX, merged into contiguous segments.

export interface Segment {
  addr: number;
  data: Uint8Array;
}

interface Chunk {
  addr: number;
  bytes: number[];
}

function hexBytes(line: string, lineNo: number): number[] {
  if (line.length % 2 || !/^[0-9A-Fa-f]*$/.test(line)) throw new Error(`Line ${lineNo}: not hex`);
  const out: number[] = [];
  for (let i = 0; i < line.length; i += 2) out.push(parseInt(line.slice(i, i + 2), 16));
  return out;
}

/** Merge chunks into sorted contiguous segments; later chunks win on overlap. */
export function mergeChunks(chunks: Chunk[]): Segment[] {
  const mem = new Map<number, number>();
  for (const c of chunks) c.bytes.forEach((b, i) => mem.set(c.addr + i, b));
  const addrs = [...mem.keys()].sort((a, b) => a - b);
  const segs: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= addrs.length; i++) {
    if (i === addrs.length || addrs[i] !== addrs[i - 1] + 1) {
      segs.push({ addr: addrs[start], data: Uint8Array.from(addrs.slice(start, i), (a) => mem.get(a)!) });
      start = i;
    }
  }
  return segs;
}

export function parseSrec(text: string): Segment[] {
  const chunks: Chunk[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== 'S') throw new Error(`Line ${n + 1}: not an S-record`);
    const type = line[1];
    const b = hexBytes(line.slice(2), n + 1);
    if (b[0] !== b.length - 1) throw new Error(`Line ${n + 1}: bad length`);
    if ((b.reduce((s, x) => s + x, 0) & 0xff) !== 0xff) throw new Error(`Line ${n + 1}: bad checksum`);
    const alen = { '1': 2, '2': 3, '3': 4 }[type];
    if (alen) {
      const addr = b.slice(1, 1 + alen).reduce((a, x) => a * 256 + x, 0);
      chunks.push({ addr, bytes: b.slice(1 + alen, -1) });
    } else if ('789'.includes(type)) {
      break;
    } else if (!'0356'.includes(type)) {
      throw new Error(`Line ${n + 1}: unsupported record S${type}`);
    }
  }
  return mergeChunks(chunks);
}

export function parseIntelHex(text: string): Segment[] {
  const chunks: Chunk[] = [];
  let base = 0;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`Line ${n + 1}: not Intel HEX`);
    const b = hexBytes(line.slice(1), n + 1);
    if (b.length !== b[0] + 5) throw new Error(`Line ${n + 1}: bad length`);
    if (b.reduce((s, x) => s + x, 0) & 0xff) throw new Error(`Line ${n + 1}: bad checksum`);
    const data = b.slice(4, -1);
    switch (b[3]) {
      case 0: chunks.push({ addr: base + b[1] * 256 + b[2], bytes: data }); break;
      case 1: return mergeChunks(chunks);
      case 2: base = (data[0] * 256 + data[1]) * 16; break;
      case 4: base = (data[0] * 256 + data[1]) * 0x10000; break;
      case 3: case 5: break;
      default: throw new Error(`Line ${n + 1}: unsupported record type ${b[3]}`);
    }
  }
  return mergeChunks(chunks);
}

export function parseImage(name: string, text: string): Segment[] {
  const segs = /\.hex$/i.test(name) || text.trimStart().startsWith(':') ? parseIntelHex(text) : parseSrec(text);
  if (!segs.length) throw new Error(`${name}: no data records`);
  return segs;
}
