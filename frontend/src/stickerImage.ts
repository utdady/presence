export const STICKER_MAX_EDGE = 512
export const STICKER_MAX_B64_CHARS = 200_000

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

/** Resize and JPEG-compress a sticker for local store + send. */
export async function fileToSticker(
  file: Blob,
  nameHint?: string,
): Promise<{ imageB64: string; mime: 'image/jpeg'; name: string }> {
  const img = await loadImage(file)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (!nw || !nh) throw new Error('Invalid image')

  const scale = Math.min(1, STICKER_MAX_EDGE / Math.max(nw, nh))
  const w = Math.max(1, Math.round(nw * scale))
  const h = Math.max(1, Math.round(nh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, 0, 0, w, h)

  for (const quality of [0.82, 0.65, 0.5, 0.35]) {
    const blob = await canvasToJpeg(canvas, quality)
    const imageB64 = await blobToBase64(blob)
    if (imageB64.length <= STICKER_MAX_B64_CHARS) {
      const base =
        nameHint?.replace(/\.[^.]+$/, '').slice(0, 48) ||
        (file instanceof File ? file.name.replace(/\.[^.]+$/, '').slice(0, 48) : '') ||
        'Sticker'
      return { imageB64, mime: 'image/jpeg', name: base || 'Sticker' }
    }
  }
  throw new Error('Sticker too large — try a simpler image')
}
