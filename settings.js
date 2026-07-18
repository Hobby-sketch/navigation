/**
 * settings.js
 * Wires up the "Pengaturan" (Settings) view: speed unit, brightness,
 * Wake Lock, fullscreen, destructive resets (with confirmation), and the
 * PWA install prompt.
 */

import { storage } from './storage.js';
import { applyBrightnessOverlay, showToast } from './ui.js';

export class SettingsManager {
  constructor({ onUnitChange, onResetOdometer, onClearHistory }) {
    this.onUnitChange = onUnitChange;
    this.onResetOdometer = onResetOdometer;
    this.onClearHistory = onClearHistory;
    this.wakeLock = null;
    this.deferredInstallPrompt = null;

    const saved = storage.getSettings();
    this.unit = saved.unit || 'kmh';
    this.brightness = typeof saved.brightness === 'number' ? saved.brightness : 100;
    this.wakeLockEnabled = saved.wakeLockEnabled !== false;

    this._bindUnit();
    this._bindBrightness();
    this._bindWakeLock();
    this._bindFullscreen();
    this._bindResets();
    this._bindInstall();

    applyBrightnessOverlay(this.brightness);
  }

  _bindUnit() {
    const group = document.getElementById('setting-unit');
    group.querySelectorAll('.segmented__btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.unit === this.unit);
      btn.addEventListener('click', () => {
        this.unit = btn.dataset.unit;
        storage.updateSetting('unit', this.unit);
        group.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('active', b === btn));
        this.onUnitChange?.(this.unit);
      });
    });
  }

  _bindBrightness() {
    const slider = document.getElementById('setting-brightness');
    slider.value = String(this.brightness);
    slider.addEventListener('input', () => {
      this.brightness = Number(slider.value);
      applyBrightnessOverlay(this.brightness);
      storage.updateSetting('brightness', this.brightness);
    });
  }

  _bindWakeLock() {
    const checkbox = document.getElementById('setting-wakelock');
    checkbox.checked = this.wakeLockEnabled;
    checkbox.addEventListener('change', () => {
      this.wakeLockEnabled = checkbox.checked;
      storage.updateSetting('wakeLockEnabled', this.wakeLockEnabled);
      if (this.wakeLockEnabled) this.requestWakeLock();
      else this.releaseWakeLock();
    });
    if (this.wakeLockEnabled) this.requestWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wakeLockEnabled) this.requestWakeLock();
    });
  }

  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* user gesture / support issue — silently ignore */ }
  }

  releaseWakeLock() {
    this.wakeLock?.release?.();
    this.wakeLock = null;
  }

  _bindFullscreen() {
    document.getElementById('btn-fullscreen').addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (e) {
        showToast('Fullscreen tidak didukung di browser ini');
      }
    });
  }

  _bindResets() {
    document.getElementById('btn-reset-odometer').addEventListener('click', () => {
      const ok = window.confirm('Reset odometer total? Tindakan ini tidak dapat dibatalkan.');
      if (ok) {
        this.onResetOdometer?.();
        showToast('Odometer total direset');
      }
    });
    document.getElementById('btn-clear-history').addEventListener('click', () => {
      const ok = window.confirm('Hapus semua riwayat perjalanan?');
      if (ok) {
        this.onClearHistory?.();
        showToast('Riwayat dihapus');
      }
    });
  }

  _bindInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
    });
    document.getElementById('btn-install-app').addEventListener('click', async () => {
      if (!this.deferredInstallPrompt) {
        showToast('Gunakan menu browser: "Tambah ke Layar Utama"');
        return;
      }
      this.deferredInstallPrompt.prompt();
      await this.deferredInstallPrompt.userChoice;
      this.deferredInstallPrompt = null;
    });
    window.addEventListener('appinstalled', () => showToast('Aplikasi terpasang'));
  }
}
