/**
 * Offscreen audio context that plays the threshold alerts.
 * A service worker cannot play sound, so Chrome opens this short-lived
 * document for AUDIO_PLAYING.
 */
let context = null;

function audioContext() {
  if (!context) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error("AudioContext is not supported");
    context = new Ctor();
  }
  if (context.state === "suspended") context.resume();
  return context;
}

function tone(frequency, delaySec, durationSec, gainValue) {
  const ctx = audioContext();
  const start = ctx.currentTime + delaySec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationSec + 0.03);
}

function play(kind) {
  if (kind === "low") {
    // two falling tones
    tone(932, 0, 0.16, 0.22);
    tone(622, 0.2, 0.28, 0.22);
  } else if (kind === "low-urgent") {
    // urgent night low: the falling pair twice, louder
    tone(932, 0, 0.16, 0.26);
    tone(622, 0.2, 0.28, 0.26);
    tone(932, 0.55, 0.16, 0.26);
    tone(622, 0.75, 0.32, 0.26);
  } else if (kind === "stale") {
    // signal loss: one soft low blip, deliberately not alarming
    tone(440, 0, 0.3, 0.12);
  } else if (kind === "pred") {
    // prediction: gentle two-tone heads-up
    tone(784, 0, 0.14, 0.16);
    tone(988, 0.18, 0.2, 0.16);
  } else {
    // three rising tones
    tone(659, 0, 0.14, 0.2);
    tone(880, 0.18, 0.14, 0.2);
    tone(1175, 0.36, 0.3, 0.2);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "beep") return false;
  try {
    play(message.kind || "high");
    respond({ ok: true });
  } catch (err) {
    respond({ ok: false, error: String(err?.message || err) });
  }
  return false;
});
