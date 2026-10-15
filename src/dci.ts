// Silicon Labs Debug Challenge Interface on AP1, ported from reflash.py.
// https://docs.silabs.com/shared-content/latest/efr32-dci-swd-programming/03-debug-challenge-interface-dci
import { Adi, sleep } from './adi';

const IDR = 0x010000fc;
const TAR = 0x01000004;
const DRW = 0x0100000c;
export const DCI_IDR = 0x54770002;
const DCI_WRITE = 0x1000;
const DCI_READ = 0x1004;
const DCI_STATUS = 0x1008;

export const CMD_STATUS = 0xfe010000;
export const CMD_UNLOCK_ERASE = 0x430f0000;

export interface DciStatus {
  status: number;
  family: string;
  seVersion: number;
  debugLock: number;
  notes: string[];
}

export class Dci {
  constructor(private adi: Adi) {}

  async check(): Promise<void> {
    const idr = await this.adi.readAP(IDR);
    if (idr !== DCI_IDR) throw new Error(`AP1 IDR is 0x${idr.toString(16)}, expected 0x54770002: is this an EFR32xG2x?`);
  }

  private async reg(sel: number): Promise<number> {
    return (await this.adi.run([...this.adi.ap(TAR, sel), ...this.adi.ap(DRW)]))[0];
  }

  private async waitStatus(ok: (s: number) => boolean, deadline: number, what: string) {
    while (!ok(await this.reg(DCI_STATUS))) {
      if (Date.now() > deadline) throw new Error(`Timed out ${what} DCI command`);
      await sleep(1);
    }
  }

  async execute(command: number, payload: number[] = [], timeoutMs = 400): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    const cmd = [0, command, ...payload];
    cmd[0] = cmd.length * 4;
    const canWrite = (s: number) => (s & 0x1) === 0;
    const canRead = (s: number) => (s & 0x100) !== 0;

    for (const w of cmd) {
      await this.waitStatus(canWrite, deadline, 'writing');
      await this.adi.run([...this.adi.ap(TAR, DCI_WRITE), ...this.adi.ap(DRW, w)]);
    }
    await this.waitStatus(canRead, deadline, 'reading');
    const hdr = await this.reg(DCI_READ);
    if (hdr >>> 16) throw new Error(`DCI command 0x${command.toString(16)} returned response ${hdr >>> 16}`);
    const rsp: number[] = [];
    for (let i = 0; i < (hdr & 0xffff) / 4 - 1; i++) {
      await this.waitStatus(canRead, deadline, 'reading');
      rsp.push(await this.reg(DCI_READ));
    }
    return rsp;
  }

  async status(): Promise<DciStatus> {
    return decodeStatus(await this.execute(CMD_STATUS));
  }

  /** Debug unlock + mass erase (keeps userdata). Needs a reset afterwards. */
  async unlockErase(): Promise<void> {
    await this.execute(CMD_UNLOCK_ERASE, [], 2000);
  }
}

export function decodeStatus(words: number[]): DciStatus {
  const s = words.length > 5 ? words.slice(4) : words;
  const debugLock = s[3] >>> 0;
  const notes: string[] = [];
  if (debugLock === 0) notes.push('No debug locks applied - flashing can proceed');
  if (debugLock & 1) notes.push('Debug lock is applied - flashing not possible without unlock');
  if (debugLock & 2) notes.push('Debug unlock is allowed');
  if (debugLock & 4) notes.push('Authenticated unlock is allowed - not supported here (needs the key)');
  return {
    status: s[0] >>> 0,
    family: `EFR32xG2${((s[1] >>> 24) + 1).toString(16)}`,
    seVersion: s[1] & 0xffffff,
    debugLock,
    notes,
  };
}
