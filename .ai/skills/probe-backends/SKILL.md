---
name: probe-backends
description: Probe contract and the CMSIS-DAP v2 / J-Link WebUSB backends: adding or fixing a probe, SWD acks, batching, nRESET, USB interface matching, and read-only smoke tests on real hardware. Use when a probe won't connect, returns NO_ACK/FAULT, or a new probe type is added.
---

# Probe backends

All unlock and flash logic runs on top of `src/probe/types.ts`. A backend only moves raw SWD
DP/AP register transfers:

- `open()`: claim the USB device.
- `connect(clockHz)`: line reset and JTAG-to-SWD, read DPIDR, clear sticky errors, power up
  debug.
- `transfer(ops)`: batched DP/AP ops. Returns the read values in order.
- `setReset(asserted)`: drive nRESET.
- `close()`

## Transfer semantics every backend must keep

- AP reads are posted on the wire. Return each read's real value by reading RDBUFF; never
  return the previous AP read's value.
- Retry WAIT internally. Throw `ProbeError` with `ack` and `opIndex` on FAULT or NO_ACK.
- Batch as much as the probe allows. Flashing speed depends on it: `flash.ts` sends bursts of
  up to 128 WDATA writes.
- `adi.ts` caches SELECT and addresses APs in pyOCD style (`apsel << 24 | reg`), so a backend
  never handles SELECT itself.

## CMSIS-DAP v2 (`cmsisdap.ts`)

- The browser offers devices with a vendor-class (0xFF) interface. The backend prefers the
  interface whose string contains "CMSIS-DAP" and takes the bulk IN/OUT endpoints. It reads the
  packet size from DAP_Info.
- Runs of at least 4 ops on the same register use DAP_TransferBlock. Mixed ops use
  DAP_Transfer, split to fit the packet size.
- nRESET uses DAP_SWJ_Pins, bit 0x80.
- The user's probe is a Waveshare ESP32-S3-GEEK running esp-usb-bridge (VID 0x303A, PID 0x1002,
  64-byte packets). Its LCD shows the DPIDR it sniffs, a quick wiring check. The firmware
  lives in a separate esp-usb-bridge fork.
- CMSIS-DAP v1 (HID / WebHID) is not implemented.

## J-Link (`jlink.ts`)

- This is a port of probe-rs's J-Link protocol code (MIT/Apache-2.0; keep the attribution
  header). It drives raw SWD bit sequences (HW_JTAG3), so ack and parity checking happen on the
  host.
- On macOS it claims interface 2 (bulk EP3, 64-byte packets) with no driver. On Windows,
  SEGGER's driver blocks WebUSB, so users need Zadig to install WinUSB on that interface.
- The Silicon Labs Simplicity Link Debugger (Si-DBG1015A) reports "Silicon Labs J-Link OB".
  Opening it, reading its firmware, capabilities and VTref, and selecting SWD are verified.
  **Not yet verified:** any real target transfer, nRESET, and whether the bits this firmware
  reads back sit at the same offsets as on stock J-Links. Check the ACK bit position first,
  the first time a target answers.
- `getTargetVoltage()` returns volts. A reading of about 3.3 V can be the debugger's own
  supply, so it doesn't prove the tag is powered.

## Hardware smoke testing (read-only)

```sh
npx vite-node tools/jlink-smoke.ts      # J-Link
npx vite-node tools/cmsisdap-smoke.ts   # CMSIS-DAP v2 (e.g. the ESP32-S3-GEEK)
```

It opens the probe, reads firmware, capabilities and VTref, selects SWD, and reads DPIDR and
CTRL/STAT. It never writes DP or AP registers or memory, and never pulses nRESET. Keep new
smoke scripts read-only. Destructive steps need the user's approval for that specific tag
(see the Hard safety rules).

## Traps

- **NO_ACK on DPIDR:** check, in order, wiring, tag power, and EM4 deep sleep. A sleeping tag
  needs connect-under-reset: hold nRESET low, connect, then release.
- **Unplug detection:** `main.ts` watches the backend's public `device` property. Keep
  `constructor(device: USBDevice)` and that property on every backend.
