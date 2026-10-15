import { Adi } from './adi';
import { Dci } from './dci';
import { programFlash, readUserdata, resetTarget } from './flash';
import { parseImage, type Segment } from './image';
import { CMSISDAP_USB_FILTERS, CmsisDapProbe } from './probe/cmsisdap';
import { JLINK_USB_FILTERS, JLinkProbe } from './probe/jlink';
import type { Probe } from './probe/types';

interface FirmwareEntry {
  version: number;
  variant: string;
  file: string;
  size: number;
}

const DEFAULT_VARIANT = 'SOLUM_AUTODETECT_FULL';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  probeType: $<HTMLSelectElement>('probeType'),
  connect: $<HTMLButtonElement>('connect'),
  disconnect: $<HTMLButtonElement>('disconnect'),
  info: $<HTMLDListElement>('info'),
  unlock: $<HTMLButtonElement>('unlock'),
  dumpUd: $<HTMLButtonElement>('dumpUd'),
  reset: $<HTMLButtonElement>('reset'),
  version: $<HTMLSelectElement>('version'),
  variant: $<HTMLSelectElement>('variant'),
  file: $<HTMLInputElement>('file'),
  flash: $<HTMLButtonElement>('flash'),
  progress: $<HTMLProgressElement>('progress'),
  progressText: $<HTMLSpanElement>('progressText'),
  log: $<HTMLPreElement>('log'),
};

let probe: (Probe & { getTargetVoltage?: () => Promise<number> }) | undefined;
let adi: Adi | undefined;
let manifest: FirmwareEntry[] = [];
let busy = false;

function log(msg: string) {
  ui.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

const hex = (v: number, w = 8) => `0x${(v >>> 0).toString(16).padStart(w, '0')}`;

function refresh() {
  const connected = !!adi;
  ui.connect.disabled = busy || connected || !('usb' in navigator);
  ui.probeType.disabled = connected;
  for (const b of [ui.disconnect, ui.unlock, ui.dumpUd, ui.reset, ui.flash]) b.disabled = busy || !connected;
}

function setInfo(rows: [string, string][]) {
  ui.info.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

async function run(label: string, fn: () => Promise<void>) {
  busy = true;
  refresh();
  try {
    await fn();
  } catch (e) {
    log(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  } finally {
    busy = false;
    refresh();
  }
}

async function readStatus(): Promise<[string, string][]> {
  const dpidr = await adi!.connect();
  log(`Connected, DPIDR ${hex(dpidr)}`);
  const rows: [string, string][] = [['Probe', probe!.name], ['DPIDR', hex(dpidr)]];
  if (probe!.getTargetVoltage) rows.push(['VTref', `${(await probe!.getTargetVoltage()).toFixed(2)} V`]);
  const dci = new Dci(adi!);
  await dci.check();
  const s = await dci.status();
  rows.push(
    ['Device', s.family],
    ['SE firmware', hex(s.seVersion, 6)],
    ['Status', hex(s.status)],
    ['Debug lock', `${hex(s.debugLock)}: ${s.notes.join('; ')}`],
  );
  log(`DCI: ${s.family}, SE ${hex(s.seVersion, 6)}, ${s.notes.join('; ')}`);
  return rows;
}

ui.connect.onclick = () =>
  run('Connect', async () => {
    const jlink = ui.probeType.value === 'jlink';
    const device = await navigator.usb.requestDevice({ filters: jlink ? JLINK_USB_FILTERS : CMSISDAP_USB_FILTERS });
    probe = jlink ? new JLinkProbe(device) : new CmsisDapProbe(device);
    await probe.open();
    adi = new Adi(probe);
    try {
      setInfo(await readStatus());
    } catch (e) {
      await disconnect();
      throw e;
    }
  });

async function disconnect() {
  await probe?.close();
  probe = undefined;
  adi = undefined;
  setInfo([]);
}

ui.disconnect.onclick = () => run('Disconnect', async () => { await disconnect(); log('Disconnected'); });

ui.unlock.onclick = () => {
  const ok = confirm(
    'Unlock & erase will ERASE THE ENTIRE MAIN FLASH (bootloader, firmware and settings). ' +
      'Userdata (UD) is kept. This cannot be undone.\n\nContinue?',
  );
  if (!ok) return;
  run('Unlock & erase', async () => {
    log('Issuing DCI unlock & erase (takes up to 2 s)…');
    await new Dci(adi!).unlockErase();
    log('Erase done, pulsing nRESET and reconnecting');
    await resetTarget(adi!, false);
    setInfo(await readStatus());
    log(`AP0 IDR ${hex(await adi!.readAP(0x000000fc))}: core debug reachable`);
  });
};

ui.dumpUd.onclick = () =>
  run('Dump userdata', async () => {
    const ud = await readUserdata(adi!);
    const lines = ['      0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F'];
    for (let i = 0; i < ud.length; i += 16) {
      lines.push(`${i.toString(16).padStart(3, '0')}: ${[...ud.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
    log(`Userdata (1024 bytes):\n${lines.join('\n')}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ud as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    a.download = 'userdata.bin';
    a.click();
    URL.revokeObjectURL(a.href);
  });

ui.reset.onclick = () => run('Reset', async () => { await resetTarget(adi!); await adi!.connect(); log('Target reset'); });

async function loadFirmware(): Promise<{ name: string; segments: Segment[] }> {
  const local = ui.file.files?.[0];
  if (local) return { name: local.name, segments: parseImage(local.name, await local.text()) };
  const entry = manifest.find((f) => f.version === Number(ui.version.value) && f.variant === ui.variant.value);
  if (!entry) throw new Error('Pick a firmware version and variant, or a local file');
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`Download ${entry.file}: HTTP ${res.status}`);
  return { name: entry.file.split('/').pop()!, segments: parseImage(entry.file, await res.text()) };
}

ui.flash.onclick = () =>
  run('Flash', async () => {
    const { name, segments } = await loadFirmware();
    log(`Flashing ${name}: ${segments.map((s) => `${hex(s.addr)}+${s.data.length}`).join(', ')}`);
    let t0 = 0;
    await programFlash(
      adi!,
      segments,
      ({ done, total, phase }) => {
        if (!t0 && done) t0 = performance.now();
        ui.progress.value = done / total;
        const rate = t0 ? done / ((performance.now() - t0) / 1000) : 0;
        const eta = rate ? ` · ~${Math.ceil((total - done) / rate)} s left` : '';
        ui.progressText.textContent = `${phase}: ${(done / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB${eta}`;
      },
      log,
    );
    log(`Wrote and verified ${name}; resetting target`);
    await resetTarget(adi!);
    await adi!.connect();
    log('Done');
  });

function fillVariants() {
  const v = Number(ui.version.value);
  const variants = manifest.filter((f) => f.version === v).map((f) => f.variant);
  const keep = ui.variant.value;
  ui.variant.replaceChildren(...variants.map((name) => new Option(name, name)));
  ui.variant.value = variants.includes(keep) ? keep : variants.includes(DEFAULT_VARIANT) ? DEFAULT_VARIANT : variants[0];
}

async function loadManifest() {
  try {
    const res = await fetch('manifest.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()).firmware;
    const versions = [...new Set(manifest.map((f) => f.version))].sort((a, b) => b - a);
    ui.version.replaceChildren(...versions.map((v) => new Option(`v${v}${v === versions[0] ? ' (latest)' : ''}`, String(v))));
    fillVariants();
  } catch (e) {
    log(`No firmware catalogue (${e instanceof Error ? e.message : e}); use a local file`);
  }
}

ui.version.onchange = fillVariants;
if (!('usb' in navigator)) $('unsupported').hidden = false;
else navigator.usb.addEventListener('disconnect', (e) => {
  if (adi && (probe as unknown as { device?: USBDevice })?.device === e.device) {
    log('Probe unplugged');
    void disconnect().then(refresh);
  }
});
refresh();
void loadManifest();
