import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import {
  clearRememberedCreds,
  getRememberedCreds,
  setRememberedCreds,
} from '../credentials'
import { formatProductVersion } from '../appVersion'
import { ThemeToggle } from '../components/ThemeToggle'
import { BrandMark } from '../components/BrandMark'

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"
        />
        <circle
          cx="12"
          cy="12"
          r="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"
      />
      <circle
        cx="12"
        cy="12"
        r="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        d="M4 20L20 4"
      />
    </svg>
  )
}

export function LoginPage({ onJoin }: { onJoin?: () => void }) {
  const { login } = useAuth()
  const [username, setUsername] = useState(
    () => getRememberedCreds()?.username ?? '',
  )
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(() => !!getRememberedCreds())
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const user = username.trim()
      await login(user, password)
      if (remember) {
        setRememberedCreds({ username: user })
      } else {
        clearRememberedCreds()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-theme">
        <ThemeToggle />
      </div>
      <div className="login-panel">
        <BrandMark size={36} />
        <p className="login-version" aria-label="App version">
          {formatProductVersion()}
        </p>
        <h1>Sign in</h1>
        <p className="login-sub">
          Same username and password work on any device. Invite-only — messages
          live only while both of you are here.
        </p>
        <form onSubmit={onSubmit} className="login-form">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                <EyeIcon open={showPassword} />
              </button>
            </span>
          </label>
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember username on this device</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Continue'}
          </button>
          {onJoin && (
            <button type="button" className="ghost-btn" onClick={onJoin}>
              Have an invite? Join
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
