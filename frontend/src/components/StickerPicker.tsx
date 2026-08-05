import { useCallback, useEffect, useRef, useState } from 'react'
import { fileToSticker } from '../stickerImage'
import {
  deleteSticker,
  listStickers,
  putSticker,
  STICKER_MAX_COUNT,
  type StickerRecord,
} from '../stickerStore'

interface StickerPickerProps {
  onSend: (imageB64: string, mime: string) => void
  onClose?: () => void
  disabled?: boolean
}

export function StickerPicker({ onSend, onClose, disabled }: StickerPickerProps) {
  const [stickers, setStickers] = useState<StickerRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    setStickers(await listStickers())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function onImport(files: FileList | null) {
    if (!files?.length) return
    setError(null)
    setBusy(true)
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        const { imageB64, mime, name } = await fileToSticker(file, file.name)
        await putSticker({
          id: crypto.randomUUID(),
          name,
          mime,
          imageB64,
          createdAt: Date.now(),
        })
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function onDelete(id: string) {
    await deleteSticker(id)
    await reload()
  }

  return (
    <div className="sticker-picker" role="dialog" aria-label="Stickers">
      <div className="sticker-picker-toolbar">
        <span className="sticker-picker-title">
          Stickers ({stickers.length}/{STICKER_MAX_COUNT})
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => void onImport(e.target.files)}
        />
        <button
          type="button"
          className="ghost-btn"
          disabled={busy || stickers.length >= STICKER_MAX_COUNT}
          onClick={() => inputRef.current?.click()}
        >
          Import
        </button>
        {onClose && (
          <button type="button" className="ghost-btn" onClick={onClose}>
            Done
          </button>
        )}
      </div>
      {error && <p className="composer-error">{error}</p>}
      {stickers.length === 0 ? (
        <p className="sticker-picker-empty">
          Import stickers from your photos to send them while both of you are
          online.
        </p>
      ) : (
        <div className="sticker-picker-grid">
          {stickers.map((s) => (
            <div key={s.id} className="sticker-picker-item">
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => onSend(s.imageB64, s.mime)}
                aria-label={`Send ${s.name}`}
              >
                <img
                  src={`data:${s.mime};base64,${s.imageB64}`}
                  alt={s.name}
                  draggable={false}
                />
              </button>
              <button
                type="button"
                className="sticker-picker-del"
                aria-label={`Delete ${s.name}`}
                onClick={() => void onDelete(s.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
