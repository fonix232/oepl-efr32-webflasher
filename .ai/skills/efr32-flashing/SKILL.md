---
name: efr32-flashing
description: EFR32xG22 unlock and programming over SWD: the DCI status and unlock commands, MSC flash registers, the erase/write/verify sequence, userdata, reset, and the test simulator. Use when changing dci.ts, flash.ts, adi.ts or test/sim.ts, or when debugging a failed unlock or flash.
---

# EFR32xG22 flashing

The behavioural spec is `reflash.py` in Tag_FW_EFR32xG22. The page runs these steps:

1. Read DCI status.
2. Optionally unlock and erase.
3. Pulse reset and reconnect.
4. Optionally dump userdata.
5. Program the full image: bootloader at 0x0, app from 0x6000.
6. Reset.

## DCI (Debug Challenge Interface), `dci.ts`

- It sits on AP1. IDR at 0x010000FC must read 0x54770002; any other value means this isn't an
  xG2x part with DCI.
- Commands go through the DCI registers: write 0x1000, read 0x1004, status 0x1008. They are
  accessed via TAR 0x01000004 and DRW 0x0100000C.
- **Status (0xFE010000):** the response decodes to device status, the family, the Secure
  Engine firmware version and the lock bits:
  - 0x1: debug-locked
  - 0x2: debug unlock allowed
  - 0x4: authenticated unlock only (not supported)
- **Unlock (0x430F0000):** this mass-erases the device. Allow a 2 s timeout. The SWD link may
  drop during the erase, so pulse reset and reconnect afterwards.

## Flash (MSC), `flash.ts`

Offsets are from the GSDK 4.4 efr32bg22 headers. The early research notes had them wrong by
4, so don't revert to those.

| Register | Address / value |
| --- | --- |
| MSC base | 0x40030000 |
| WRITECTRL | +0x0C |
| WRITECMD | +0x10 |
| ADDRB | +0x14 |
| WDATA | +0x18 |
| STATUS | +0x1C |
| LOCK | +0x3C, key 0x1B71 |
| CMU CLKEN1 | 0x40008068, MSC clock bit 17 |
| Page size | 8 KB |
| Flash size | 512 KB |
| Userdata | 0x0FE00000 (0x100 words) |

- **Halt first:** write DHCSR = 0xA05F0003.
- **Erase only the pages the image touches:** `planPages` trims all-0xFF words. A v43 full
  image erases pages 0–32.
- **Writes** go through the MEM-AP banked data registers. TAR is set to MSC+0x10, so BD2 is
  WDATA and BD3 is STATUS. WDATA is written in bursts. If STATUS shows WDATAREADY is not
  ready mid-burst, the code falls back to slow, polled writes.
- **Verify** by reading back every page that was written.
- **Reset:** `resetTarget` first does a soft reset, releasing the halt and setting SYSRESETREQ
  via AIRCR = 0x05FA0004, ignoring transfer errors. It then always pulses nRESET, because the
  soft reset can't be relied on after an unlock.

## Simulator (`test/sim.ts`)

It models the DP/AP registers, the DCI mailbox, MSC (erase, write, lock, the not-ready path)
and TAR wrap. The end-to-end test in `test/flash.test.ts` runs status, unlock, reset, userdata,
programming the real v43 image with verify, and reset. When you change flashing behaviour,
change the simulator to match the reference manual first, then the code.

## Not verified on hardware

- the real flash rate
- how MSC behaves across roughly 1 ms USB gaps in the middle of a burst
- the secure-access bit choice in CSW
- unlock reliability across the erase

Record bring-up results in `.ai/plans/roadmap.md`.
