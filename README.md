# OEPL EFR32xG22 Web Flasher

A static web page that does what `reflash.py` in
[Tag_FW_EFR32xG22](https://github.com/OpenEPaperLink/Tag_FW_EFR32xG22) does, from the browser over WebUSB:
read the debug-lock status (Silicon Labs DCI), unlock and erase, dump the userdata page, flash a full
`.s37` / `.hex` image (bootloader and app), and reset the tag.

## Supported probes and browsers

- **CMSIS-DAP v2** (WebUSB bulk), for example DAPLink, the Raspberry Pi debugprobe, or Espressif's esp-usb-bridge.
  CMSIS-DAP v1 (HID-only) probes are not supported.
- **SEGGER J-Link** over WebUSB. On Windows this needs the WinUSB driver bound to the J-Link, which can
  break SEGGER's own tools.
- Desktop Chrome, Edge or Opera. Firefox and Safari have no WebUSB.
- Linux needs a udev rule that gives your user access to the probe.

Wire SWCLK, SWDIO, nRESET, GND and VTref/3V3. Power the tag from 3.3 V or less, never 5 V.

## Local development

```sh
npm install
npm run dev     # manifest from ../Tag_FW_EFR32xG22, then the Vite dev server
npm test        # SREC/HEX parser, CMSIS-DAP encoding, ADI + flash against a simulated EFR32
npm run build   # static site in dist/
```

The firmware catalogue is built from `full_binaries/v*/*.s37` in a Tag_FW_EFR32xG22 checkout. The
script looks for that checkout at `../Tag_FW_EFR32xG22` by default. To use a different checkout, pass
its path as an argument or set `FIRMWARE_REPO`. A relative path is resolved from this folder:
`FIRMWARE_REPO=/path/to/checkout npm run build`.

## Deploy

`.github/workflows/pages.yml` runs on every push to `main` and on manual dispatch. It checks out the
firmware repository (set by `FIRMWARE_REPOSITORY` / `FIRMWARE_REF` in the workflow `env`), runs the
tests, builds the site and deploys it to GitHub Pages. The firmware files are served from the Pages
site itself, because GitHub Release assets don't send CORS headers.

To enable deployment, open **Settings → Pages** and set **Source** to **GitHub Actions**.

## Layout

- `src/probe/` holds the probe backends behind `types.ts` (`cmsisdap.ts`, `jlink.ts`).
- `src/adi.ts` handles DP SELECT caching, AP addressing and MEM-AP block transfers (respecting the 1 KB TAR wrap).
- `src/dci.ts` implements the Debug Challenge Interface on AP1 (status, unlock and erase).
- `src/flash.ts` covers halting the core, MSC page erase and write with read-back verification, userdata and reset.
- `src/image.ts` contains the S-record and Intel HEX parsers.

## License

[MIT](LICENSE). `src/probe/jlink.ts` is a port of the J-Link protocol code from
[probe-rs](https://github.com/probe-rs/probe-rs) (MIT or Apache-2.0). The firmware images it flashes come
from Tag_FW_EFR32xG22 and keep that repository's licence (CC BY-NC-SA 4.0).
