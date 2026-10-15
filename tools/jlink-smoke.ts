// Read-only J-Link smoke test against real hardware, using node-usb's WebUSB API.
// Run: npx vite-node tools/jlink-smoke.ts
// Does: open, firmware/caps, VTref, select SWD + speed, line reset + DPIDR, CTRL/STAT read.
// Never writes DP/AP registers, memory or flash, and never pulses nRESET.
import { webusb } from 'usb';
import { JLINK_USB_FILTERS, JLinkProbe } from '../src/probe/jlink';

const device = await webusb.requestDevice({ filters: JLINK_USB_FILTERS });
const probe = new JLinkProbe(device as unknown as USBDevice);
try {
  await probe.open();
  console.log('probe:   ', probe.name, `(PID 0x${device.productId.toString(16)})`);
  console.log('firmware:', probe.firmware);
  console.log('caps:     0x' + (probe.caps >>> 0).toString(16));
  const v = await probe.getTargetVoltage();
  console.log('VTref:   ', v.toFixed(3), 'V');
  if (v < 1.0) console.log('VTref ~0 V: no powered target on the connector; trying SWD anyway.');
  const dpidr = await probe.readDpidr(1_000_000);
  console.log('DPIDR:    0x' + dpidr.toString(16).padStart(8, '0'));
  const [id, ctrl] = await probe.transfer([{ ap: false, reg: 0x0 }, { ap: false, reg: 0x4 }]);
  console.log('batched DPIDR/CTRL/STAT: 0x' + id.toString(16), '0x' + ctrl.toString(16).padStart(8, '0'));
} catch (e) {
  console.log('stopped:', (e as Error).message);
} finally {
  await probe.close();
}
