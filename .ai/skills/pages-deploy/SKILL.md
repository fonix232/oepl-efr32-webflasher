---
name: pages-deploy
description: Building and publishing the site to GitHub Pages: the firmware manifest, the second firmware checkout in CI, pointing at a fork or branch, and enabling Pages. Use when the deploy fails, firmware versions are missing from the picker, or the firmware source changes.
---

# Pages deploy

## Firmware catalogue

- `scripts/build-manifest.mjs` scans `full_binaries/v*/*.s37` in a Tag_FW_EFR32xG22 checkout.
  It writes `.firmware/manifest.json` (version, variant, file, size) and copies the `.s37`
  files there. Vite serves `.firmware/` as static files, so they end up in `dist/`.
- The checkout location comes from the script argument, then `$FIRMWARE_REPO`, then
  `../Tag_FW_EFR32xG22`. Relative paths are resolved from the repository root.
- In the UI, the version picker defaults to the newest version and the variant picker to
  `SOLUM_AUTODETECT_FULL`.

## Workflow (`.github/workflows/pages.yml`)

1. It runs on a push to `main` and on manual dispatch.
2. It checks out this repository, then the firmware repository into `firmware-repo/`. The
   firmware repository and ref come from `FIRMWARE_REPOSITORY` / `FIRMWARE_REF` in the
   workflow `env`; change them there to publish a fork or branch.
3. It runs `npm ci`, `npm test`, then `npm run build` with `FIRMWARE_REPO=firmware-repo`.
4. It deploys with `upload-pages-artifact` and then `deploy-pages`.

**One-time setup:** in the repository, open Settings → Pages and set Source to **GitHub
Actions**.

## Traps

- **Use relative asset paths:** Vite's `base` is `'./'`, so the site works under
  `/<repo>/`. Don't switch to absolute paths.
- **Serve firmware from Pages, not from GitHub Release assets:** Release downloads send no
  CORS headers.
- **Don't commit firmware here:** binaries and `.firmware/` are build outputs and are
  ignored.
- **Firmware missing from the manifest:** if a new firmware version doesn't appear, check
  the `vNN/` directory naming in the firmware repository. The scan expects `v<number>` and
  `.s37` files.
