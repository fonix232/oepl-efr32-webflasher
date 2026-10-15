// EFR32xG22 target operations over AP0: halt, MSC flash programming, userdata read, reset.
// Register layout verified against GSDK 4.4 efr32bg22_msc.h / efr32bg22_cmu.h / em_msc.c.
import { Adi, AP_TAR, sleep } from './adi';
import type { Segment } from './image';

const DHCSR = 0xe000edf0;
const AIRCR = 0xe000ed0c;
const CMU_CLKEN1 = 0x40008068;
const CMU_CLKEN1_MSC = 1 << 17;
const MSC = 0x40030000;
const MSC_WRITECTRL = MSC + 0x0c;
const MSC_WRITECMD = MSC + 0x10;
const MSC_ADDRB = MSC + 0x14;
const MSC_STATUS = MSC + 0x1c;
const MSC_LOCK = MSC + 0x3c;
const LOCK_KEY = 0x1b71;
const WRITECTRL_WREN = 1 << 0;
const WRITECMD_ERASEPAGE = 1 << 1;
const WRITECMD_WRITEEND = 1 << 2;
const STATUS_BUSY = 1 << 0;
const STATUS_LOCKED = 1 << 1;
const STATUS_INVADDR = 1 << 2;
const STATUS_WDATAREADY = 1 << 3;
const STATUS_PENDING = 1 << 5;
// MEM-AP banked data registers: with TAR = 0x40030010, BD2 = MSC+0x18 (WDATA), BD3 = MSC+0x1C (STATUS).
const AP_BD2 = 0x18;
const AP_BD3 = 0x1c;

export const PAGE_SIZE = 0x2000;
export const FLASH_SIZE = 0x80000;
export const USERDATA_BASE = 0x0fe00000;
const BATCH_WORDS = 128;

export async function halt(adi: Adi): Promise<void> {
  await adi.write32(DHCSR, 0xa05f0003); // DBGKEY | C_HALT | C_DEBUGEN
  for (let i = 0; i < 100; i++) {
    if ((await adi.read32(DHCSR)) & (1 << 17)) return; // S_HALT
    await sleep(5);
  }
  throw new Error('Core did not halt');
}

export async function readUserdata(adi: Adi): Promise<Uint8Array> {
  const words = await adi.readBlock(USERDATA_BASE, 0x100);
  return new Uint8Array(words.buffer); // little-endian host, same byte order as reflash.py
}

/** Hard reset via nRESET plus a soft reset (AIRCR), so it also works when nRESET isn't wired. */
export async function resetTarget(adi: Adi, soft = true): Promise<void> {
  if (soft) {
    try {
      await adi.write32(DHCSR, 0xa05f0000); // release halt and debug
      await adi.write32(AIRCR, 0x05fa0004); // SYSRESETREQ
    } catch {
      // the reset can cut the transfer short; nRESET below still runs
    }
  }
  await sleep(100);
  await adi.probe.setReset(true);
  await sleep(100);
  await adi.probe.setReset(false);
  await sleep(200);
}

/** One 8 KB page to program: the page image (0xFF where the file has no data) and the word range to write. */
interface Page {
  addr: number;
  words: Uint32Array;
  first: number;
  end: number;
}

export function planPages(segments: Segment[]): Page[] {
  const pages = new Map<number, Uint8Array>();
  for (const s of segments) {
    if (s.addr < 0 || s.addr + s.data.length > FLASH_SIZE) {
      throw new Error(`Segment 0x${s.addr.toString(16)}+${s.data.length} is outside main flash (0..0x${FLASH_SIZE.toString(16)})`);
    }
    for (let i = 0; i < s.data.length; ) {
      const a = s.addr + i;
      const base = a - (a % PAGE_SIZE);
      const n = Math.min(s.data.length - i, base + PAGE_SIZE - a);
      if (!pages.has(base)) pages.set(base, new Uint8Array(PAGE_SIZE).fill(0xff));
      pages.get(base)!.set(s.data.subarray(i, i + n), a - base);
      i += n;
    }
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([addr, bytes]) => {
      const words = new Uint32Array(bytes.buffer);
      let first = 0;
      let end = words.length;
      while (first < end && words[first] === 0xffffffff) first++;
      while (end > first && words[end - 1] === 0xffffffff) end--;
      return { addr, words, first, end };
    });
}

async function waitIdle(adi: Adi, what: string, timeoutMs = 1000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await adi.read32(MSC_STATUS);
    if (!(st & (STATUS_BUSY | STATUS_PENDING))) return st;
    if (Date.now() > deadline) throw new Error(`MSC ${what} timed out (STATUS 0x${st.toString(16)})`);
    await sleep(1);
  }
}

async function erasePage(adi: Adi, addr: number) {
  await adi.write32(MSC_ADDRB, addr);
  const st = await adi.read32(MSC_STATUS);
  if (st & (STATUS_INVADDR | STATUS_LOCKED)) throw new Error(`Cannot erase 0x${addr.toString(16)} (STATUS 0x${st.toString(16)})`);
  await adi.write32(MSC_WRITECMD, WRITECMD_ERASEPAGE);
  await waitIdle(adi, 'page erase');
}

class NotReady extends Error {}

/**
 * Write words with one MSC burst. Each WDATA write is followed by a STATUS read in the same batch;
 * if a STATUS shows WDATAREADY clear, the next write may have been dropped, so throw NotReady.
 * With batch = 1 we poll instead, which is slow but always safe.
 */
async function writeBurst(adi: Adi, addr: number, words: Uint32Array, batch: number) {
  await adi.write32(MSC_ADDRB, addr);
  if ((await adi.read32(MSC_STATUS)) & STATUS_INVADDR) throw new Error(`Invalid flash address 0x${addr.toString(16)}`);
  for (let i = 0; i < words.length; ) {
    const n = Math.min(batch, words.length - i);
    const ops = [...(await adi.memOps()), ...adi.ap(AP_TAR, MSC + 0x10)];
    for (let k = 0; k < n; k++) ops.push(...adi.ap(AP_BD2, words[i + k]), ...adi.ap(AP_BD3));
    const st = await adi.run(ops);
    i += n;
    if (st.slice(0, -1).some((s) => !(s & STATUS_WDATAREADY))) throw new NotReady();
    let last = st[st.length - 1];
    const deadline = Date.now() + 100;
    while (i < words.length && !(last & STATUS_WDATAREADY)) {
      if (Date.now() > deadline) throw new Error('MSC WDATAREADY timed out');
      last = await adi.read32(MSC_STATUS);
    }
  }
  await adi.write32(MSC_WRITECMD, WRITECMD_WRITEEND);
  await waitIdle(adi, 'write');
}

export interface Progress {
  done: number;
  total: number;
  phase: string;
}

/**
 * Program a flash image: halt, erase only touched pages, write, verify by read-back.
 * Pages that fail fast programming or verification are re-erased and rewritten slowly once.
 */
export async function programFlash(
  adi: Adi,
  segments: Segment[],
  onProgress: (p: Progress) => void = () => {},
  log: (msg: string) => void = () => {},
): Promise<void> {
  const pages = planPages(segments);
  const total = pages.reduce((s, p) => s + (p.end - p.first) * 4, 0);
  let done = 0;
  onProgress({ done, total, phase: 'Halting' });
  await halt(adi);

  const clk = await adi.read32(CMU_CLKEN1);
  await adi.write32(CMU_CLKEN1, clk | CMU_CLKEN1_MSC);
  await adi.write32(MSC_LOCK, LOCK_KEY);
  await adi.write32(MSC_WRITECTRL, (await adi.read32(MSC_WRITECTRL)) | WRITECTRL_WREN);
  try {
    for (const p of pages) {
      const words = p.words.subarray(p.first, p.end);
      const addr = p.addr + p.first * 4;
      for (const batch of [BATCH_WORDS, 1]) {
        onProgress({ done, total, phase: `Page 0x${p.addr.toString(16).padStart(5, '0')}` });
        await erasePage(adi, p.addr);
        if (!words.length) break;
        try {
          await writeBurst(adi, addr, words, batch);
        } catch (e) {
          if (!(e instanceof NotReady) || batch === 1) throw e;
          log(`Page 0x${p.addr.toString(16)}: MSC not ready during fast write, retrying slowly`);
          continue;
        }
        const back = await adi.readBlock(addr, words.length);
        const bad = back.findIndex((w, i) => w !== words[i]);
        if (bad < 0) break;
        const msg = `Verify failed at 0x${(addr + bad * 4).toString(16)}: read 0x${back[bad].toString(16)}, expected 0x${words[bad].toString(16)}`;
        if (batch === 1) throw new Error(msg);
        log(`${msg}; retrying page slowly`);
      }
      done += words.length * 4;
      onProgress({ done, total, phase: 'Programming' });
    }
  } finally {
    await adi.write32(MSC_WRITECTRL, (await adi.read32(MSC_WRITECTRL)) & ~WRITECTRL_WREN).catch(() => {});
    await adi.write32(MSC_LOCK, 0).catch(() => {});
  }
  onProgress({ done: total, total, phase: 'Done' });
}
