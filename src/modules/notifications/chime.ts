/**
 * The notification chime, synthesised rather than fetched.
 *
 * No audio file: an asset would be one more thing to serve, to cache-bust and to keep inside the
 * artifact CSP, for about a second of sound that two oscillators describe exactly. It is also the
 * only way to keep it silent-by-default on a page that never needs it — nothing is loaded until
 * the first chime is actually asked for.
 *
 * What it sounds like, and why: two soft sine tones a perfect fourth apart (A5 → D6), the second
 * starting while the first is still ringing. A rising interval reads as "something arrived"
 * rather than "something is wrong" — a falling one is the shape alarms use. Sine waves have no
 * harshness to be tired of, the whole thing is under 400ms, and the peak gain is 0.09, which is
 * audible in a quiet office and ignorable in a loud one.
 */

const A5 = 880;
const D6 = 1174.66;

let ctx: AudioContext | null = null;

/**
 * Browsers refuse to start an AudioContext until the page has been interacted with, and they are
 * right to. Creating it lazily means the first chime after a fresh load may be the one that gets
 * refused — so `resume()` is attempted every time and its rejection is ignored. From the first
 * click anywhere in the app onwards, it works.
 */
function context(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null; // no Web Audio (very old browser, or a locked-down embed)
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

function tone(
  audio: AudioContext,
  freq: number,
  startAt: number,
  seconds: number,
  peak: number,
) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startAt);

  // A short attack and a long exponential tail: an instant on/off is a click, and a click is the
  // part of a notification sound people come to hate.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + seconds);

  osc.connect(gain).connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + seconds + 0.02);
}

/**
 * Play it once. Never throws: a browser that refuses to make a noise must not take a screen down
 * with it, and there is nothing useful to tell the user about it either.
 */
export function playChime(): void {
  try {
    const audio = context();
    if (!audio) return;
    const now = audio.currentTime;
    tone(audio, A5, now, 0.26, 0.09);
    tone(audio, D6, now + 0.11, 0.3, 0.075);
  } catch {
    /* a silent failure is the correct failure for a sound */
  }
}
