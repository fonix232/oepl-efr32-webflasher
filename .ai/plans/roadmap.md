# Roadmap

## Done (offline only)
- CMSIS-DAP v2 and J-Link WebUSB backends behind `src/probe/types.ts`
- DCI status and unlock, MSC programming with read-back verify, userdata dump, reset
- SREC and Intel HEX parsers, a firmware manifest, and the GitHub Pages workflow
- 15 vitest tests, including an end-to-end run against a simulated EFR32xG22

## Hardware bring-up (next)
1. Flash esp-usb-bridge onto the ESP32-S3-GEEK. Confirm that Chrome can claim its CMSIS-DAP
   interface and that the LCD shows a DPIDR from a tag.
2. Run Connect and Status against a tag (read-only).
3. Get the J-Link (Si-DBG1015A) to read a DPIDR from a responding target. Check the read-back
   bit offsets, nRESET, and connect-under-reset for tags in EM4.
4. With user approval, on a sacrificial tag: unlock, flash v43, verify, reset. Measure the
   flash time.

## Later
- CMSIS-DAP v1 / WebHID
- A RAM flash algorithm, if a licence-clean one exists
- OTA over Web Bluetooth, if the tag firmware gains BLE
