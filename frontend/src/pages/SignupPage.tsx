import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import { ThemeToggle } from '../components/ThemeToggle'

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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signup({
        invite_code: inviteCode.trim(),
        username: username.trim(),
        display_name: displayName.trim() || username.trim(),
        password,
      })
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
        <p className="brand">Presence</p>
        <h1>Join with invite</h1>
        <p className="login-sub">
          Invite-only. After you join, you can message the hub — not other
          members.
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