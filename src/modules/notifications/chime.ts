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
 * right to. This only creates it; RESUMING is `playChime`'s job, and the difference is the whole
 * of the bug described there.
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
  return ctx;
}

/** Build the two tones and start them. Only ever called on a RUNNING context — see below. */
function ring(audio: AudioContext): void {
  const now = audio.currentTime;
  tone(audio, A5, now, 0.26, 0.09);
  tone(audio, D6, now + 0.11, 0.3, 0.075);
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
/**
 * Wake the audio system on the FIRST interaction with the app, whatever it was.
 *
 * Safari is the reason. Every browser refuses to make noise before a page has been interacted
 * with, but Safari also insists the context be started **synchronously inside the gesture** — a
 * `resume()` whose work continues in a `.then()` has, as far as it is concerned, left the gesture
 * behind. So there is no version of "resume, then play" that is safe there; the only reliable
 * shape is to have resumed already.
 *
 * This listens once, on the first pointer or key event anywhere, resumes, and unhooks itself.
 * From then on every chime — the tray's and the settings screen's preview alike — finds a running
 * context and simply plays. `capture: true` so it is heard before anything calls
 * `stopPropagation`, and `once: true` so it costs one listener for the life of the tab.
 *
 * Reported 2026-09-06: sound worked in Chromium and not in Safari on the deployed site, which is
 * exactly the shape of this. It is also why the first fix attempt was wrong — it moved the work
 * further OUT of the gesture rather than removing the need to be in one.
 */
function unlockOnFirstGesture(): void {
  if (typeof window === "undefined") return;
  const wake = () => {
    const audio = context();
    if (audio && audio.state === "suspended") void audio.resume().catch(() => {});
  };
  for (const event of ["pointerdown", "keydown", "touchstart"] as const) {
    window.addEventListener(event, wake, { once: true, capture: true });
  }
}
unlockOnFirstGesture();

export function playChime(): void {
  try {
    const audio = context();
    if (!audio) return;
    /**
     * Resume and schedule SYNCHRONOUSLY, in that order and without awaiting.
     *
     * Awaiting the resume and scheduling in the callback is the tidier-looking version and the
     * wrong one: it hands the work to a microtask, and Safari treats the user gesture as over by
     * then. The context is normally already running by here anyway — `unlockOnFirstGesture` saw
     * to that on the first click anywhere in the app — so this line is the fallback for the case
     * where the very first interaction IS the Play it button.
     */
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    ring(audio);
  } catch {
    /* a silent failure is the correct failure for a sound */
  }
}
