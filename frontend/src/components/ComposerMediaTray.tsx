import { useEffect, useState } from 'react'
import { hapticLight, hapticSelection } from '../haptics'
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
  /** Hide emoji tab (mobile keyboards already provide emoji). */
  hideEmoji?: boolean
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
  hideEmoji = false,
}: ComposerMediaTrayProps) {
  if (!open) return null

  const effectiveTab: MediaTrayTab =
    hideEmoji && stickersEnabled ? 'stickers' : tab

  return (
    <div className="composer-media-tray">
      <div className="composer-media-tabs">
        {!hideEmoji && (
          <button
            type="button"
            className={effectiveTab === 'emoji' ? 'is-active' : undefined}
            onClick={() => {
              hapticSelection()
              onTabChange('emoji')
            }}
          >
            Emoji
          </button>
        )}
        {stickersEnabled && (
          <button
            type="button"
            className={effectiveTab === 'stickers' ? 'is-active' : undefined}
            onClick={() => {
              hapticSelection()
              onTabChange('stickers')
            }}
          >
            Stickers
          </button>
        )}
        <button
          type="button"
          className="ghost-btn composer-media-done"
          onClick={() => {
            hapticLight()
            onClose()
          }}
        >
          Done
        </button>
      </div>
      {effectiveTab === 'emoji' && !hideEmoji ? (
        <EmojiPicker onPick={onPickEmoji} />
      ) : stickersEnabled && onSendSticker && effectiveTab === 'stickers' ? (
        <StickerPicker
          disabled={stickersDisabled}
          onSend={(b64, mime) => {
            onSendSticker(b64, mime)
            onClose()
          }}
        />
      ) : null}
    </div>
  )
}

/** Toggle for media tray — emoji+stickers or stickers-only. */
export function ComposerMediaButton({
  open,
  disabled,
  onClick,
  stickersOnly,
}: {
  open: boolean
  disabled?: boolean
  onClick: () => void
  stickersOnly?: boolean
}) {
  return (
    <button
      type="button"
      className={`composer-tool composer-media-btn${open ? ' is-open' : ''}`}
      aria-label={
        open
          ? 'Close'
          : stickersOnly
            ? 'Stickers'
            : 'Emoji and stickers'
      }
      aria-expanded={open}
      disabled={disabled}
      onClick={() => {
        hapticLight()
        onClick()
      }}
    >
      <StickerFaceIcon />
    </button>
  )
}

/** Squircle sticker with peeled corner + smiley (emoji/stickers affordance). */
function StickerFaceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7.25 3.5h9.5A3.75 3.75 0 0 1 20.5 7.25v7.0L14.25 20.5h-7A3.75 3.75 0 0 1 3.5 16.75v-9.5A3.75 3.75 0 0 1 7.25 3.5Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 14.25 14.25 20.5v-3.4c0-1.55 1.25-2.85 2.85-2.85H20.5Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="9.35" cy="11" r="1.05" fill="currentColor" />
      <circle cx="14.65" cy="11" r="1.05" fill="currentColor" />
      <path
        d="M9.45 14.4c.8.8 1.85 1.15 2.55 1.15s1.75-.35 2.55-1.15"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
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

/** Mobile / touch-first layouts (hide in-app emoji; system keyboard has it). */
export function useMobileComposerLayout() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px), (pointer: coarse)')
    const apply = () => setMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return mobile
}
