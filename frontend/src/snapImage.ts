/** Resize + JPEG-compress a camera frame for snap relay (~400KB budget). */

export const SNAP_MAX_EDGE = 1280
export const SNAP_MAX_B64_CHARS = 400_000

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('JPEG encode failed'))
        else resolve(blob)
      },
      'image/jpeg',
      quality,
    )
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Capture from a video element into compressed JPEG base64 (no data: prefix).
 * Throws if still over size budget after quality steps.
 */
export async function videoFrameToSnapJpeg(
  video: HTMLVideoElement,
): Promise<string> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) throw new Error('Camera not ready')

  const scale = Math.min(1, SNAP_MAX_EDGE / Math.max(vw, vh))
  const w = Math.max(1, Math.round(vw * scale))
  const h = Math.max(1, Math.round(vh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(video, 0, 0, w, h)

  for (const quality of [0.7, 0.55, 0.4, 0.28]) {
    const blob = await canvasToJpeg(canvas, quality)
    const b64 = await blobToBase64(blob)
    if (b64.length <= SNAP_MAX_B64_CHARS) return b64
  }
  throw new Error('Photo too large to send — try again with less detail')
}

export function snapDataUrl(imageB64: string): string {
  return `data:image/jpeg;base64,${imageB64}`
}
