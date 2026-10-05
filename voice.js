/**
 * voice.js — Voice Guidance (Web Speech API / SpeechSynthesis)
 *
 * - Indonesian voice when available, graceful no-op when unsupported.
 * - Anti-spam: every announcement carries a `key`; a key is spoken at most
 *   once until reset() (new route), the same text is never repeated within
 *   REPEAT_GUARD_MS, and there is a minimum gap between utterances.
 * - 'now'/'urgent' announcements pre-empt a queued older one; routine ones
 *   are dropped instead of queueing up behind a long utterance.
 * - Persisted ON/OFF toggle.
 */

import { storage } from './storage.js';

const MIN_GAP_MS = 1800;
const REPEAT_GUARD_MS = 8000;
const MAX_STALE_MS = 4000; // a routine message older than this is not worth speaking

export class VoiceGuidance {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    const saved = storage.getSettings().voiceEnabled;
    this.enabled = saved !== false; // default ON
    this._spoken = new Set();
    this._lastText = '';
    this._lastAt = 0;
    this._speaking = false;
    this._voice = null;
    this._unlocked = false;
    this.listeners = new Set();
    this.history = []; // last spoken lines, for diagnostics / tests

    if (this.supported) {
      this._pickVoice();
      try { window.speechSynthesis.addEventListener('voiceschanged', () => this._pickVoice()); } catch (e) { /* old engines */ }
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

  _pickVoice() {
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      this._voice =
        voices.find((v) => /^id([-_]|$)/i.test(v.lang)) ||
        voices.find((v) => /indones/i.test(v.name)) ||
        null;
    } catch (e) { this._voice = null; }
  }

  setEnabled(on) {
    this.enabled = !!on;
    storage.updateSetting('voiceEnabled', this.enabled);
    if (!this.enabled) this.cancel();
    this._emit({ type: 'enabled', enabled: this.enabled });
  }

  toggle() { this.setEnabled(!this.enabled); return this.enabled; }

  /** iOS/Safari only allow speech after a user gesture: call once from a tap. */
  unlock() {
    if (!this.supported || this._unlocked) return;
    this._unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  /** Forget which announcements were already made (call on a new route). */
  reset() {
    this._spoken.clear();
    this._lastText = '';
  }

  cancel() {
    if (!this.supported) return;
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    this._speaking = false;
  }

  /**
   * @param {string} text
   * @param {{key?:string, urgent?:boolean}} opts
   * @returns {boolean} true if it was actually handed to the speech engine
   */
  say(text, { key = null, urgent = false } = {}) {
    if (!this.enabled || !text) return false;
    const now = Date.now();
    if (key) {
      if (this._spoken.has(key)) return false;
    }
    if (text === this._lastText && now - this._lastAt < REPEAT_GUARD_MS) return false;
    if (!urgent && now - this._lastAt < MIN_GAP_MS) return false;
    if (!urgent && this._speaking) return false;

    if (key) this._spoken.add(key);
    this._lastText = text;
    this._lastAt = now;
    this.history.push({ text, t: now, key });
    if (this.history.length > 30) this.history.shift();
    this._emit({ type: 'say', text, key });

    if (!this.supported) return true; // still "announced" (UI subtitle may show it)
    try {
      const synth = window.speechSynthesis;
      if (urgent) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this._voice?.lang || 'id-ID';
      if (this._voice) u.voice = this._voice;
      u.rate = 1.02;
      u.pitch = 1;
      u.volume = 1;
      const queuedAt = now;
      u.onstart = () => {
        this._speaking = true;
        if (!urgent && Date.now() - queuedAt > MAX_STALE_MS) { try { synth.cancel(); } catch (e) { /* ignore */ } }
      };
      u.onend = () => { this._speaking = false; };
      u.onerror = () => { this._speaking = false; };
      synth.speak(u);
    } catch (e) {
      this._speaking = false;
    }
    return true;
  }
}
