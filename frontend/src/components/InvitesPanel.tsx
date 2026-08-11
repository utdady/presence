import { useCallback, useEffect, useState } from 'react'
import { createInvite, fetchInvites, revokeInvite } from '../api'
import type { InvitePublic } from '../types'
import { hapticError, hapticLight, hapticMedium, hapticSuccess } from '../haptics'

export function InvitesPanel({ token }: { token: string }) {
  const [invites, setInvites] = useState<InvitePublic[]>([])
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const list = await fetchInvites(token)
    setInvites(list)
  }, [token])

  useEffect(() => {
    void reload().catch((e) =>
      setError(e instanceof Error ? e.message : 'Failed to load invites'),
    )
  }, [reload])

  async function onCreate() {
    setError(null)
    setBusy(true)
    hapticMedium()
    try {
      const inv = await createInvite(token, {
        label: label.trim() || undefined,
        max_uses: 1,
      })
      setLabel('')
      setInvites((prev) => [inv, ...prev])
      const url = `${window.location.origin}/?invite=${encodeURIComponent(inv.code)}`
      await navigator.clipboard.writeText(url)
      setCopied(inv.code)
      hapticSuccess()
    } catch (e) {
      hapticError()
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  async function onRevoke(code: string) {
    setError(null)
    hapticMedium()
    try {
      const inv = await revokeInvite(token, code)
      setInvites((prev) => prev.map((i) => (i.code === code ? inv : i)))
    } catch (e) {
      hapticError()
      setError(e instanceof Error ? e.message : 'Revoke failed')
    }
  }

  function copyLink(code: string) {
    hapticLight()
    const url = `${window.location.origin}/?invite=${encodeURIComponent(code)}`
    void navigator.clipboard.writeText(url).then(() => setCopied(code))
  }

  return (
    <div className="invites-panel">
      <h2>Invites</h2>
      <p className="nearby-note">
        Only you can invite. New members message you only — they cannot see
        each other.
      </p>
      <div className="invites-create">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
        />
        <button type="button" disabled={busy} onClick={() => void onCreate()}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {copied && (
        <p className="list-status">Copied invite link for {copied.slice(0, 8)}…</p>
      )}
      <ul className="invites-list">
        {invites.map((inv) => (
          <li key={inv.code} className="invites-row">
            <div>
              <div className="friend-name">
                {inv.label || inv.code.slice(0, 10) + '…'}
              </div>
              <div className="friend-state">
                {inv.revoked
                  ? 'Revoked'
                  : `${inv.uses}/${inv.max_uses} used`}
              </div>
            </div>
            <div className="invites-row-actions">
              {!inv.revoked && inv.uses < inv.max_uses && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => copyLink(inv.code)}
                >
                  Copy link
                </button>
              )}
              {!inv.revoked && (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void onRevoke(inv.code)}
                >
                  Revoke
                </button>
              )}
            </div>
          </li>
        ))}
        {invites.length === 0 && (
          <li className="nearby-note">No invites yet.</li>
        )}
      </ul>
    </div>
  )
}