/** Looping ring / ringback via Web Audio — no asset files required. */

let ctx: AudioContext | null = null
let stopCurrent: (() => void) | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

function stopCallSounds(): void {
  stopCurrent?.()
  stopCurrent = null
}

function scheduleTone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain = 0.08,
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.02)
  g.gain.setValueAtTime(gain, start + dur - 0.04)
  g.gain.linearRampToValueAtTime(0, start + dur)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur)
}

/** Incoming: classic dual-tone ring pattern. */
export function startRingtone(): void {
  stopCallSounds()
  const ac = getCtx()
  void ac.resume().catch(() => {})
  let cancelled = false
  let timer: number | null = null

  const burst = () => {
    if (cancelled) return
    const t0 = ac.currentTime + 0.02
    // Two short rings, pause, repeat (phone-like).
    scheduleTone(ac, 440, t0, 0.18)
    scheduleTone(ac, 480, t0, 0.18)
    scheduleTone(ac, 440, t0 + 0.22, 0.18)
    scheduleTone(ac, 480, t0 + 0.22, 0.18)
    timer = window.setTimeout(burst, 2000)
  }
  burst()

  stopCurrent = () => {
    cancelled = true
    if (timer != null) window.clearTimeout(timer)
  }
}

/** Outgoing: softer single-tone ringback. */
export function startRingback(): void {
  stopCallSounds()
  const ac = getCtx()
  void ac.resume().catch(() => {})
  let cancelled = false
  let timer: number | null = null

  const burst = () => {
    if (cancelled) return
    const t0 = ac.currentTime + 0.02
    scheduleTone(ac, 425, t0, 0.9, 0.055)
    timer = window.setTimeout(burst, 3000)
  }
  burst()

  stopCurrent = () => {
    cancelled = true
    if (timer != null) window.clearTimeout(timer)
  }
}

export { stopCallSounds }
