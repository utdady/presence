import { useCallback, useEffect, useState } from 'react'
import { fetchMembers } from '../api'
import type { MemberPrivate } from '../types'

export function MembersPanel({ token }: { token: string }) {
  const [members, setMembers] = useState<MemberPrivate[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const list = await fetchMembers(token)
    setMembers(list)
  }, [token])

  useEffect(() => {
    void reload().catch((e) =>
      setError(e instanceof Error ? e.message : 'Failed to load members'),
    )
  }, [reload])

  return (
    <div className="invites-panel">
      <h2>Members</h2>
      <p className="nearby-note">
        Hub-only roster. Passwords are never stored or shown — if someone loses
        theirs, issue a fresh invite.
      </p>
      <div className="invites-create">
        <button type="button" className="ghost-btn" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <ul className="invites-list">
        {members.map((m) => (
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
            </div>
          </li>
        ))}
        {members.length === 0 && (
          <li className="nearby-note">No members yet.</li>
        )}
      </ul>
    </div>
  )
}
