# Roadmap

## Done (offline only)
- CMSIS-DAP v2 and J-Link WebUSB backends behind `src/probe/types.ts`
- DCI status and unlock, MSC programming with read-back verify, userdata dump, reset
- SREC and Intel HEX parsers, a firmware manifest, and the GitHub Pages workflow
- 15 vitest tests, including an end-to-end run against a simulated EFR32xG22

## Hardware bring-up
Verified 2026-10-15, with no tag attached:
- J-Link (Si-DBG1015A) in Chrome over WebUSB: the device is claimed, SWD is selected and the
  DPIDR read gets NO_ACK, as expected with no target.
- ESP32-S3-GEEK flashed with the esp-usb-bridge fork: it enumerates as CMSIS-DAP v2
  (303a:1002). `tools/cmsisdap-smoke.ts` gets through DAP_Info and connect, then NO_ACK, as
  expected with no target.

Next, once a tag is available:
1. Run Connect and Status against the tag (read-only), on both probes. Check that the GEEK's
   LCD shows the DPIDR.
2. J-Link: the read-back offset is fixed and DPIDR verified on a real tag. Still to check: nRESET,
   and connect-under-reset for tags in EM4.
3. With user approval, on a sacrificial tag: unlock, flash v43, verify, reset. Measure the
   flash time.

## Later
- CMSIS-DAP v1 / WebHID
- A RAM flash algorithm, if a licence-clean one exists
- OTA over Web Bluetooth, if the tag firmware gains BLE
