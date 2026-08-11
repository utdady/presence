import { hapticSelection } from '../haptics'
import { useTheme } from '../theme'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const dark = theme === 'dark'

  return (
    <button
      type="button"
      className={`theme-switch${dark ? ' theme-switch--on' : ''}`}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        hapticSelection()
        toggleTheme()
      }}
    >
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-icon theme-switch-icon--sun">
          <svg width="8" height="8" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <path
              d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="theme-switch-icon theme-switch-icon--moon">
          <svg width="8" height="8" viewBox="0 0 24 24">
            <path
              d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span className="theme-switch-thumb" />
      </span>
    </button>
  )
}