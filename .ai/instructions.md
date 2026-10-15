# OEPL EFR32xG22 Web Flasher: agent instructions

A static GitHub Pages site that unlocks, dumps and flashes OpenEPaperLink EFR32xG22 e-ink tags from
the browser over WebUSB. It replaces `reflash.py` (pyOCD) from
[Tag_FW_EFR32xG22](https://github.com/OpenEPaperLink/Tag_FW_EFR32xG22). This file is the single
source of instructions for every AI tool. `AGENTS.md` (Codex), `CLAUDE.md`, `CODEX.md`, `GEMINI.md`
and `.github/copilot-instructions.md` are symlinks to it, so edit only `.ai/instructions.md`.
Skills live in `.ai/skills` and are linked from `.claude/skills`, `.agents/skills` (Codex, Gemini
CLI), `.codex/skills` and `.github/skills`. Agents live in `.ai/agents` and are linked from
`.claude/agents` and `.github/agents`.

## Layout

```
.github/workflows/   pages.yml: test, build and deploy to GitHub Pages
scripts/             build-manifest.mjs: firmware catalogue from a Tag_FW_EFR32xG22 checkout
src/                 UI (main.ts), ADI/MEM-AP (adi.ts), DCI (dci.ts), MSC flashing (flash.ts), SREC/HEX (image.ts)
src/probe/           Probe contract (types.ts) and backends: cmsisdap.ts, jlink.ts
test/                vitest: parsers, CMSIS-DAP packets, end-to-end against a simulated EFR32 (sim.ts)
tools/               read-only hardware smoke scripts (node-usb WebUSB)
.ai/                 agent instructions, skills, agents, plans; .ai/local/ is untracked scratch
```

## Hard safety rules (never break these)

- **Hardware tests by an agent are read-only unless the user approves the specific action.**
  DCI unlock (0x430F0000) mass-erases the tag, and the tag's original firmware can't be
  recovered. Flash writes, memory writes and nRESET pulses change real devices. Before running
  any of these, ask the user and name the tag.
- **Unlock and Flash need an explicit confirmation step in the UI.** Never remove it or
  auto-confirm it, including in "quick" or batch flows.
- **Never suggest powering a tag from 5 V** in UI text or docs. The EFR32BG22's absolute maximum
  supply is 3.8 V. The probe's VTref is a sense line.
- **Keep `src/probe/types.ts` stable.** Every backend implements it, and all unlock and flash
  logic sits on top of it, written once. If a backend needs more, extend the contract for every
  backend rather than special-casing one in `adi.ts`, `dci.ts` or `flash.ts`.
- **Serve firmware from the Pages site, not from GitHub Release assets.** Release downloads send
  no CORS headers, so the browser can't fetch them.

## Build and test

```sh
npm install
npm test                 # must pass before any commit
npm run build            # manifest, tsc --noEmit, then vite build into dist/
npm run dev              # local server; needs ../Tag_FW_EFR32xG22 or FIRMWARE_REPO=<path>
npx vite-node tools/jlink-smoke.ts   # read-only J-Link check on real hardware
```

- Logic changes in `adi.ts`, `dci.ts` or `flash.ts` must also be exercised by
  `test/flash.test.ts` against `test/sim.ts`. Extend the simulator rather than mocking around it.
- WebUSB works only in desktop Chromium browsers (Chrome, Edge, Opera). Vitest and Node can't
  stand in for the real browser and probe. When a change touches USB behaviour, say whether it was
  verified on hardware, and with which probe and browser.

## Conventions

- One commit per finished, verified task. No Co-Authored-By or other AI attribution trailers.
  Push only when asked.
- This repository is public. Never commit probe serial numbers, tag MAC addresses, userdata
  dumps or tag firmware read from a device. Use placeholders such as `<J-LINK-SERIAL>` and
  `<TAG-MAC>` instead.
- Firmware binaries are not committed here. CI checks out the firmware repository named by
  `FIRMWARE_REPOSITORY` / `FIRMWARE_REF` in `pages.yml`.
- Notes, hardware logs and investigation evidence go in `.ai/local/`.

## Skills, agents, plans

- `.ai/skills/probe-backends`: the Probe contract, CMSIS-DAP v2 and J-Link backends, and
  hardware smoke testing.
- `.ai/skills/efr32-flashing`: DCI unlock and status, MSC registers, the flash sequence, and the
  simulator.
- `.ai/skills/pages-deploy`: the firmware manifest, the Pages workflow, and pointing the build at
  a fork.
- `.ai/agents/webflasher-reviewer.agent.md`: reviews changes for destructive-action safety,
  contract drift and flashing correctness.
- `.ai/plans/roadmap.md`: hardware bring-up status and next steps.
