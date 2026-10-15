// Read-only CMSIS-DAP v2 smoke test against real hardware, using node-usb's WebUSB API.
// Run: npx vite-node tools/cmsisdap-smoke.ts
// Does: open (DAP_Info), connect (SWD line reset + DPIDR; on success, DP power-up), CTRL/STAT read.
// Never touches APs, memory or flash, and never pulses nRESET.
import { webusb } from 'usb';
import { CMSISDAP_USB_FILTERS, CmsisDapProbe } from '../src/probe/cmsisdap';

const device = await webusb.requestDevice({ filters: CMSISDAP_USB_FILTERS });
const probe = new CmsisDapProbe(device as unknown as USBDevice);
try {
  await probe.open();
  console.log('probe:   ', probe.name, `(${device.vendorId.toString(16)}:${device.productId.toString(16)})`);
  const dpidr = await probe.connect(1_000_000);
  console.log('DPIDR:    0x' + dpidr.toString(16).padStart(8, '0'));
  const [ctrl] = await probe.transfer([{ ap: false, reg: 0x4 }]);
  console.log('CTRL/STAT 0x' + (ctrl >>> 0).toString(16).padStart(8, '0'));
} catch (e) {
  console.log('stopped:', (e as Error).message);
} finally {
  await probe.close();
}
