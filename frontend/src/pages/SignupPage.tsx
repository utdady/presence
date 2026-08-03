import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import { setRememberedCreds } from '../credentials'
import { ThemeToggle } from '../components/ThemeToggle'
import { BrandMark } from '../components/BrandMark'

export function SignupPage({
  initialInvite = '',
  onBack,
}: {
  initialInvite?: string
  onBack: () => void
}) {
  const { signup } = useAuth()
  const [inviteCode, setInviteCode] = useState(initialInvite)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const user = username.trim()
      await signup({
        invite_code: inviteCode.trim(),
        username: user,
        display_name: displayName.trim() || user,
        password,
      })
      if (remember) {
        setRememberedCreds({ username: user, password })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed')
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
        <h1>Join with invite</h1>
        <p className="login-sub">
          Create your account on this device. You can sign in with the same
          username and password on other phones or browsers later.
        </p>
        <form onSubmit={onSubmit} className="login-form">
          <label>
            Invite code
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
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
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
              placeholder="Optional"
            />
          </label>
          <label>
            Password
            <span className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember on this device</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
          <button type="button" className="ghost-btn" onClick={onBack}>
            Back to sign in
          </button>
        </form>
      </div>
    </div>
  )
}
