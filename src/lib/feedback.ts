// ─── R25: shared non-visual feedback (sound + haptics) ──────────────
// Extracted verbatim from the R24 Team Wall so EVERY screen can confirm
// actions by EAR and TOUCH — staff who can't read fluently still get
// instant confirmation. Pure WebAudio oscillators: zero assets, zero
// network, degrades silently when audio is unavailable or blocked.
//
// Sound language (consistent platform-wide):
//   sndTap     — short neutral tick: a tile/button was pressed
//   sndDigit   — keypad digit tick (same family as sndTap, slightly drier)
//   sndSuccess — rising two-note chime: an action completed
//   sndError   — low double buzz: something was rejected
//   sndAlert   — triple attention chime: NEW work arrived (KDS orders)
//   sndIn      — C5→G5 rising: clock-in / start
//   sndOut     — G5→C5 falling: clock-out / finish

let audioCtx: AudioContext | null = null

function tone(freqs: number[], duration = 0.09, type: OscillatorType = 'sine', gain = 0.1) {
  try {
    if (typeof window === 'undefined') return
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      audioCtx = new Ctor()
    }
    void audioCtx.resume()
    let t = audioCtx.currentTime
    for (const f of freqs) {
      const osc = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      osc.type = type
      osc.frequency.value = f
      g.gain.setValueAtTime(gain, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration)
      osc.connect(g).connect(audioCtx.destination)
      osc.start(t)
      osc.stop(t + duration)
      t += duration * 0.85
    }
  } catch {
    // audio is a bonus — never break the flow over it
  }
}

export const sndTap = () => tone([720], 0.05, 'sine', 0.05)
export const sndDigit = () => tone([660], 0.06, 'sine', 0.06)
export const sndError = () => tone([170, 140], 0.14, 'sawtooth', 0.08)
export const sndSuccess = () => tone([523.25, 659.25, 783.99], 0.09, 'sine', 0.1) // C5→E5→G5
export const sndAlert = () => tone([880, 660, 880, 660], 0.11, 'triangle', 0.12) // attention: new order
export const sndIn = () => tone([523.25, 783.99], 0.12, 'sine', 0.12) // C5 → G5 up
export const sndOut = () => tone([783.99, 523.25], 0.12, 'sine', 0.12) // G5 → C5 down

/** Re-export the raw synth for screens that need a custom cue. */
export { tone }

export function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // ignore
  }
}
