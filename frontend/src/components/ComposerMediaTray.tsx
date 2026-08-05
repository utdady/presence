import { useState } from 'react'
import { EmojiPicker } from './EmojiPicker'
import { StickerPicker } from './StickerPicker'

export type MediaTrayTab = 'emoji' | 'stickers'

interface ComposerMediaTrayProps {
  open: boolean
  tab: MediaTrayTab
  onTabChange: (tab: MediaTrayTab) => void
  onClose: () => void
  onPickEmoji: (glyph: string) => void
  onSendSticker?: (imageB64: string, mime: string) => void
  stickersEnabled?: boolean
  stickersDisabled?: boolean
}

export function ComposerMediaTray({
  open,
  tab,
  onTabChange,
  onClose,
  onPickEmoji,
  onSendSticker,
  stickersEnabled = !!onSendSticker,
  stickersDisabled,
}: ComposerMediaTrayProps) {
  if (!open) return null

  const showStickers = stickersEnabled && tab === 'stickers' && onSendSticker

  return (
    <div className="composer-media-tray">
      <div className="composer-media-tabs">
        <button
          type="button"
          className={tab === 'emoji' ? 'is-active' : undefined}
          onClick={() => onTabChange('emoji')}
        >
          Emoji
        </button>
        {stickersEnabled && (
          <button
            type="button"
            className={tab === 'stickers' ? 'is-active' : undefined}
            onClick={() => onTabChange('stickers')}
          >
            Stickers
          </button>
        )}
        <button
          type="button"
          className="ghost-btn composer-media-done"
          onClick={onClose}
        >
          Done
        </button>
      </div>
      {tab === 'emoji' || !stickersEnabled ? (
        <EmojiPicker onPick={onPickEmoji} />
      ) : showStickers ? (
        <StickerPicker
          disabled={stickersDisabled}
          onSend={(b64, mime) => {
            onSendSticker?.(b64, mime)
            onClose()
          }}
        />
      ) : null}
    </div>
  )
}

/** Toggle button for the tray — place to the right of the text field. */
export function ComposerMediaButton({
  open,
  disabled,
  onClick,
}: {
  open: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`composer-cam composer-media-btn${open ? ' is-open' : ''}`}
      aria-label={open ? 'Close emoji and stickers' : 'Emoji and stickers'}
      aria-expanded={open}
      disabled={disabled}
      onClick={onClick}
    >
      🙂
    </button>
  )
}

export function useComposerMediaTray(initial: MediaTrayTab = 'emoji') {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<MediaTrayTab>(initial)

  function toggle() {
    setOpen((v) => !v)
  }

  function close() {
    setOpen(false)
  }

  return { open, tab, setTab, toggle, close, setOpen }
}
