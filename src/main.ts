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
  logWrap: $<HTMLDetailsElement>('logWrap'),
};

// ---------- The e-ink label that mirrors the session ----------
type Tone = 'ink' | 'solid' | 'red';
interface TagState { probe: string; product: string; version: string; variant: string; band: string; tone: Tone; dpidr?: number }
const IDLE: Pick<TagState, 'probe' | 'product' | 'band' | 'tone' | 'dpidr'> = {
  probe: 'No probe', product: 'EFR32xG22 tag', band: 'Not connected', tone: 'ink', dpidr: undefined,
};
const tag: TagState = { ...IDLE, version: 'v—', variant: 'Pick a firmware' };

function drawBarcode(svg: SVGSVGElement, value?: number) {
  // 32 bits of DPIDR as thin/thick bars between guard bars; empty until a chip answers
  const widths = value === undefined ? [] : [1.5, 1.5, ...Array.from({ length: 32 }, (_, i) => ((value >>> (31 - i)) & 1 ? 3 : 1.25)), 1.5, 1.5];
  const scale = 100 / (widths.reduce((a, w) => a + w * 2, 0) || 1);
  let x = 0;
  svg.replaceChildren(...widths.map((w) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(x)); r.setAttribute('width', String(w * scale)); r.setAttribute('height', '30');
    x += w * 2 * scale;
    return r;
  }));
}

function setTag(next: Partial<TagState>) {
  const changed = (Object.keys(next) as (keyof TagState)[]).some((k) => next[k] !== tag[k]);
  Object.assign(tag, next);
  $('tagProbe').textContent = tag.probe;
  $('tagProduct').textContent = tag.product;
  $('tagVersion').textContent = tag.version;
  $('tagVariant').textContent = tag.variant;
  const band = $('tagBand');
  band.textContent = tag.band;
  band.dataset.tone = tag.tone;
  $('tagDpidr').textContent = tag.dpidr === undefined ? 'No chip ID yet' : `DPIDR ${hex(tag.dpidr).slice(2).toUpperCase()}`;
  drawBarcode(document.getElementById('tagBarcode') as unknown as SVGSVGElement, tag.dpidr);
  $('tagLed').toggleAttribute('data-on', !!adi);
  if (changed) {
    const panel = $('panel');
    panel.classList.remove('refresh');
    void panel.offsetWidth; // restart the animation
    panel.classList.add('refresh');
  }
}

function showFirmwareOnTag() {
  const local = ui.file.files?.[0];
  if (local) setTag({ version: 'Local', variant: local.name });
  else if (ui.version.value) setTag({ version: `v${ui.version.value}`, variant: ui.variant.value.replace(/_/g, ' ').toLowerCase() });
}

// ---------- Confirmation for destructive actions ----------
function askConfirm(title: string, body: string, okLabel: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('confirm');
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  const ok = $<HTMLButtonElement>('confirmOk');
  ok.textContent = okLabel;
  ok.className = 'danger-solid';
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

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
    const msg = e instanceof Error ? e.message : String(e);
    log(`${label} failed: ${msg}`);
    ui.logWrap.open = true;
    if (/NO_ACK/.test(msg)) setTag({ band: 'No response', tone: 'red' });
    else if (!/No device selected/.test(msg)) setTag({ band: `${label} failed`, tone: 'red' });
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
  const locked = (s.debugLock & 1) !== 0;
  setTag({ probe: probe!.name.replace(/^[^:]+:\s*/, ''), product: s.family, dpidr, band: locked ? 'Debug locked' : 'Unlocked', tone: locked ? 'red' : 'solid' });
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
  setTag(IDLE);
}

ui.disconnect.onclick = () => run('Disconnect', async () => { await disconnect(); log('Disconnected'); });

ui.unlock.onclick = async () => {
  const ok = await askConfirm(
    'Erase this tag?',
    'Unlocking erases the whole main flash: bootloader, firmware and settings. Userdata is kept. The original firmware can’t be recovered.',
    'Unlock and erase',
  );
  if (!ok) return;
  void run('Unlock & erase', async () => {
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

ui.flash.onclick = async () => {
  const fw = ui.file.files?.[0]?.name ?? `${ui.variant.value} v${ui.version.value}`;
  const ok = await askConfirm('Flash this tag?', `This overwrites the tag’s bootloader and firmware with ${fw}.`, 'Flash tag');
  if (!ok) return;
  void run('Flash', async () => {
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
        const pct = Math.floor((done / total) * 10) * 10; // refresh the label in 10% steps, like a real tag
        if (tag.band !== `Flashing ${pct}%`) setTag({ band: `Flashing ${pct}%`, tone: 'solid' });
      },
      log,
    );
    log(`Wrote and verified ${name}; resetting target`);
    await resetTarget(adi!);
    await adi!.connect();
    setTag({ band: 'Flashed', tone: 'solid' });
    log('Done');
  });
};

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
    showFirmwareOnTag();
  } catch (e) {
    log(`No firmware catalogue (${e instanceof Error ? e.message : e}); use a local file`);
  }
}

ui.version.onchange = () => { fillVariants(); showFirmwareOnTag(); };
ui.variant.onchange = showFirmwareOnTag;
ui.file.onchange = showFirmwareOnTag;
if (!('usb' in navigator)) $('unsupported').hidden = false;
else navigator.usb.addEventListener('disconnect', (e) => {
  if (adi && (probe as unknown as { device?: USBDevice })?.device === e.device) {
    log('Probe unplugged');
    void disconnect().then(refresh);
  }
});
refresh();
setTag({});
void loadManifest();
