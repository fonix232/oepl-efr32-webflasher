// Contract between probe backends (CMSIS-DAP, J-Link) and the shared ADI/DCI/flash logic.
// Backends only move raw SWD DP/AP register transfers; SELECT handling, MEM-AP, DCI and
// flash programming live once in shared code on top of this.

/** One SWD register transfer. `reg` is the A[3:2] register offset: 0x0, 0x4, 0x8 or 0xC. */
export type Op =
  | { ap: boolean; reg: number; write?: false }
  | { ap: boolean; reg: number; write: true; value: number };

export type Ack = 'WAIT' | 'FAULT' | 'NO_ACK' | 'PARITY';

export class ProbeError extends Error {
  constructor(message: string, readonly ack?: Ack, readonly opIndex?: number) {
    super(message);
  }
}

export interface Probe {
  /** Human-readable probe description, e.g. "CMSIS-DAP v2: ESP USB Bridge". */
  readonly name: string;

  /** Claim the USB device and initialise the probe (no target traffic yet). */
  open(): Promise<void>;

  /**
   * Select SWD, set the clock, do the line reset / JTAG-to-SWD sequence, and read DPIDR.
   * Also clears sticky errors (ABORT) and powers up debug (CTRL/STAT CDBGPWRUPREQ|CSYSPWRUPREQ).
   * Returns DPIDR.
   */
  connect(clockHz?: number): Promise<number>;

  /**
   * Execute transfers in order, batched as efficiently as the probe allows.
   * Returns read values in order (one entry per read op). AP reads are posted on the wire;
   * backends must hide that (return the real value of each AP read, e.g. via RDBUFF).
   * WAIT must be retried internally; FAULT / NO_ACK throw ProbeError with the failing op index.
   */
  transfer(ops: Op[]): Promise<number[]>;

  /** Drive the hardware nRESET line (true = held in reset). */
  setReset(asserted: boolean): Promise<void>;

  /** Release the USB device. Safe to call twice. */
  close(): Promise<void>;
}
