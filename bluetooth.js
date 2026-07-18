/**
 * bluetooth.js
 * This app never connects to the motorcycle itself — there is no ECU/CAN/OBD
 * link. This module only surfaces the *phone's* Bluetooth radio/connection
 * status in the status bar (e.g. connected to a helmet headset or earbuds),
 * using the Web Bluetooth availability check where supported.
 */

export class BluetoothStatus {
  constructor() {
    this.supported = 'bluetooth' in navigator;
    this.listeners = new Set();
    this.state = 'off'; // off | on | unsupported
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach((fn) => fn(this.state)); }

  async start() {
    if (!this.supported) {
      this.state = 'unsupported';
      this._emit();
      return;
    }
    try {
      const available = await navigator.bluetooth.getAvailability();
      this.state = available ? 'on' : 'off';
    } catch (e) {
      this.state = 'unsupported';
    }
    this._emit();

    if ('bluetooth' in navigator && navigator.bluetooth.addEventListener) {
      navigator.bluetooth.addEventListener('availabilitychanged', (e) => {
        this.state = e.value ? 'on' : 'off';
        this._emit();
      });
    }
  }
}
