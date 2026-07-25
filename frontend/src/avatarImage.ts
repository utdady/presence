/** Resize + JPEG-compress a profile photo for encrypted peer sync. */

export const AVATAR_EDGE = 256
export const AVATAR_MAX_B64_CHARS = 80_000

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

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read image'))
    }
    img.src = url
  })
}

/**
 * Center-crop to square and compress to JPEG base64 (no data: prefix).
 */
export async function fileToAvatarJpeg(file: Blob): Promise<string> {
  const img = await loadImage(file)
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  if (!side) throw new Error('Invalid image')

  const sx = Math.floor((img.naturalWidth - side) / 2)
  const sy = Math.floor((img.naturalHeight - side) / 2)

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_EDGE
  canvas.height = AVATAR_EDGE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_EDGE, AVATAR_EDGE)

  for (const quality of [0.72, 0.55, 0.4, 0.28]) {
    const blob = await canvasToJpeg(canvas, quality)
    const b64 = await blobToBase64(blob)
    if (b64.length <= AVATAR_MAX_B64_CHARS) return b64
  }
  throw new Error('Photo too large — try a simpler image')
}

export function avatarDataUrl(imageB64: string): string {
  return `data:image/jpeg;base64,${imageB64}`
}
