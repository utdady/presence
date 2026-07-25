/** Voice recording helpers — Opus/WebM preferred, short clips for WS relay. */

export const VOICE_MAX_MS = 60_000
export const VOICE_MAX_B64_CHARS = 500_000

export function pickRecorderMime(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]
  if (typeof MediaRecorder === 'undefined') return undefined
  return candidates.find((m) => MediaRecorder.isTypeSupported(m))
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    // Avoid spread (call-stack limits on large audio)
    binary += Array.from(slice, (b) => String.fromCharCode(b)).join('')
  }
  return btoa(binary)
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Blob URL is more reliable for playback than giant data: URLs. */
export function voiceObjectUrl(mime: string, audioB64: string): string {
  const bytes = base64ToUint8(audioB64)
  // Copy into a plain ArrayBuffer-backed view for BlobPart typing
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy.buffer], { type: mime || 'audio/webm' })
  return URL.createObjectURL(blob)
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/** Read real media duration from a recorded blob (falls back to wallMs). */
export function measureBlobDurationMs(
  blob: Blob,
  wallMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    const done = (ms: number) => {
      URL.revokeObjectURL(url)
      resolve(Math.max(1000, Math.round(ms)))
    }
    const timer = window.setTimeout(() => done(wallMs), 2000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      window.clearTimeout(timer)
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        done(audio.duration * 1000)
      } else {
        done(wallMs)
      }
    }
    audio.onerror = () => {
      window.clearTimeout(timer)
      done(wallMs)
    }
    audio.src = url
  })
}
