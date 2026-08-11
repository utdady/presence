import { useMemo, useState } from 'react'
import { EMOJI_CATEGORIES } from '../emojiData'
import { hapticLight, hapticSelection } from '../haptics'

interface EmojiPickerProps {
  onPick: (emoji: string) => void
  onClose?: () => void
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('')
  const [catId, setCatId] = useState(EMOJI_CATEGORIES[0]?.id ?? 'smileys')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      return EMOJI_CATEGORIES.flatMap((c) =>
        c.emojis.filter(
          (e) => e.name.includes(q) || e.glyph.includes(q),
        ),
      )
    }
    return EMOJI_CATEGORIES.find((c) => c.id === catId)?.emojis ?? []
  }, [query, catId])

  return (
    <div className="emoji-picker" role="dialog" aria-label="Emoji">
      <div className="emoji-picker-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji"
          autoComplete="off"
        />
        {onClose && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              hapticLight()
              onClose()
            }}
          >
            Done
          </button>
        )}
      </div>
      {!query && (
        <div className="emoji-picker-cats">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === catId ? 'is-active' : undefined}
              onClick={() => {
                hapticSelection()
                setCatId(c.id)
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker-grid">
        {list.map((e) => (
          <button
            key={`${e.glyph}-${e.name}`}
            type="button"
            title={e.name}
            onClick={() => {
              hapticSelection()
              onPick(e.glyph)
            }}
          >
            {e.glyph}
          </button>
        ))}
      </div>
    </div>
  )
}
