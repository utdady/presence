import { useCallback, useEffect, useState } from 'react'
import { fetchMembers } from '../api'
import type { MemberPrivate } from '../types'

export function MembersPanel({ token }: { token: string }) {
  const [members, setMembers] = useState<MemberPrivate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const reload = useCallback(async () => {
    const list = await fetchMembers(token)
    setMembers(list)
  }, [token])

  useEffect(() => {
    void reload().catch((e) =>
      setError(e instanceof Error ? e.message : 'Failed to load members'),
    )
  }, [reload])

  function copyPassword(member: MemberPrivate) {
    if (!member.password) return
    void navigator.clipboard.writeText(member.password).then(() => {
      setCopied(member.id)
      window.setTimeout(() => setCopied(null), 2000)
    })
  }

  function copyCredentialsJson() {
    const payload = {
      _note:
        'Exported from Presence hub Members. Keep private — contains plaintext passwords.',
      users: members.map((m) => ({
        username: m.username,
        password: m.password ?? '',
        display_name: m.display_name,
        role: m.role,
      })),
    }
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopied('export')
        window.setTimeout(() => setCopied(null), 2000)
      })
  }

  function downloadCredentialsJson() {
    const payload = {
      _note:
        'Exported from Presence hub Members. Keep private — contains plaintext passwords.',
      users: members.map((m) => ({
        username: m.username,
        password: m.password ?? '',
        display_name: m.display_name,
        role: m.role,
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'credentials.local.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="invites-panel">
      <h2>Members</h2>
      <p className="nearby-note">
        Hub-only. Invite signups store their password here so you can track
        accounts. Passwords also update when someone signs in.
      </p>
      <div className="invites-create">
        <button type="button" className="ghost-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <button type="button" className="ghost-btn" onClick={copyCredentialsJson}>
          Copy credentials JSON
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={downloadCredentialsJson}
        >
          Download credentials.local.json
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {copied === 'export' && (
        <p className="list-status">Copied credentials JSON</p>
      )}
      <ul className="invites-list">
        {members.map((m) => {
          const show = !!revealed[m.id]
          return (
            <li key={m.id} className="invites-row members-row">
              <div>
                <div className="friend-name">
                  {m.display_name}
                  <span className="friend-state"> · {m.username}</span>
                </div>
                <div className="friend-state">
                  {m.role}
                  {m.online ? ' · online' : ' · offline'}
                </div>
                <div className="members-password">
                  {m.password ? (
                    <>
                      <code>{show ? m.password : '••••••••••••'}</code>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() =>
                          setRevealed((prev) => ({
                            ...prev,
                            [m.id]: !prev[m.id],
                          }))
                        }
                      >
                        {show ? 'Hide' : 'Show'}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => copyPassword(m)}
                      >
                        {copied === m.id ? 'Copied' : 'Copy'}
                      </button>
                    </>
                  ) : (
                    <span className="friend-state">
                      Password unknown — appears after they sign in once
                    </span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
        {members.length === 0 && (
          <li className="nearby-note">No members yet.</li>
        )}
      </ul>
    </div>
  )
}
