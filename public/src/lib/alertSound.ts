// Custom trade-entry alert: distinctive 3-tone chirp via Web Audio +
// optional device vibration. No asset file needed.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/**
 * Play a distinctive trade-entry chime (rising 3-note arpeggio + sparkle).
 * Different from generic toast/system sounds so it's instantly recognizable.
 */
export function playTradeAlertSound() {
  try {
    const ac = getCtx();
    if (!ac) return;
    if (ac.state === "suspended") ac.resume().catch(() => {});

    const now = ac.currentTime;
    // Rising arpeggio: A5 -> C#6 -> E6 (major triad — "positive entry")
    const notes: { freq: number; t: number; dur: number }[] = [
      { freq: 880, t: 0.0, dur: 0.18 },
      { freq: 1108.73, t: 0.13, dur: 0.18 },
      { freq: 1318.51, t: 0.26, dur: 0.32 },
      // Sparkle tail
      { freq: 2637.02, t: 0.42, dur: 0.12 },
    ];

    const master = ac.createGain();
    master.gain.value = 0.35;
    master.connect(ac.destination);

    for (const n of notes) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(n.freq, now + n.t);
      g.gain.setValueAtTime(0.0001, now + n.t);
      g.gain.exponentialRampToValueAtTime(0.6, now + n.t + 0.015);
      g.gain.exponentialRampToValueAtTime(
        0.0001,
        now + n.t + n.dur,
      );
      osc.connect(g).connect(master);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.dur + 0.02);
    }
  } catch {
    // Silent fail — alerts shouldn't break the app
  }
}

const VIB_KEY = "smc-notify-vibrate";

export function isVibrationEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Default ON if device supports it
  const stored = localStorage.getItem(VIB_KEY);
  if (stored === null) return "vibrate" in navigator;
  return stored === "true";
}

export function setVibrationEnabled(on: boolean) {
  localStorage.setItem(VIB_KEY, on ? "true" : "false");
}

export function vibrateTradeAlert() {
  try {
    if (!isVibrationEnabled()) return;
    if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
    // Distinctive pattern: short-short-LONG (Morse-like "trade!")
    navigator.vibrate([80, 60, 80, 60, 220]);
  } catch {
    // ignore
  }
}
