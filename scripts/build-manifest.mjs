// Builds .firmware/ (Vite's publicDir): manifest.json plus a copy of every full_binaries/v*/*.s37
// from the firmware repo. Firmware repo path: argv[2], else $FIRMWARE_REPO, else ../Tag_FW_EFR32xG22.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, process.argv[2] ?? process.env.FIRMWARE_REPO ?? '../Tag_FW_EFR32xG22');
const src = join(repo, 'full_binaries');
const out = join(root, '.firmware');

if (!existsSync(src)) {
  console.error(`No full_binaries/ in ${repo}. Pass the Tag_FW_EFR32xG22 checkout path as argument or FIRMWARE_REPO.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const firmware = [];
for (const dir of readdirSync(src)) {
  const m = /^v(\d+)$/.exec(dir);
  if (!m) continue;
  for (const name of readdirSync(join(src, dir))) {
    const f = new RegExp(`^(.+)_v${m[1]}\\.s37$`).exec(name);
    if (!f) continue;
    const file = `firmware/${dir}/${name}`;
    mkdirSync(join(out, 'firmware', dir), { recursive: true });
    copyFileSync(join(src, dir, name), join(out, file));
    firmware.push({ version: Number(m[1]), variant: f[1], file, size: statSync(join(src, dir, name)).size });
  }
}
firmware.sort((a, b) => b.version - a.version || a.variant.localeCompare(b.variant));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), firmware }, null, 1));
console.log(`manifest.json: ${firmware.length} images from ${src}`);
