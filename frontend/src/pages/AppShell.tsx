import { useRef, useState } from 'react'
import { useAuth } from '../auth'
import { fileToAvatarJpeg } from '../avatarImage'
import { Avatar } from '../components/Avatar'
import { ChatView } from '../components/ChatView'
import { ThemeToggle } from '../components/ThemeToggle'
import { InvitesPanel } from '../components/InvitesPanel'
import { NearbyCallPage } from '../nearby/NearbyCallPage'
import { usePresenceSession } from '../usePresenceSession'

export function AppShell() {
  const { user, token, publicKey, privateKey, logout } = useAuth()
  const [activePeerId, setActivePeerId] = useState<string | null>(null)

  if (!user || !token || !publicKey || !privateKey) return null

  return (
    <PresenceInner
      user={user}
      token={token}
      publicKey={publicKey}
      privateKey={privateKey}
      logout={logout}
      activePeerId={activePeerId}
      setActivePeerId={setActivePeerId}
    />
  )
}

function PresenceInner({
  user,
  token,
  publicKey,
  privateKey,
  logout,
  activePeerId,
  setActivePeerId,
}: {
  user: NonNullable<ReturnType<typeof useAuth>['user']>
  token: string
  publicKey: string
  privateKey: string
  logout: () => void
  activePeerId: string | null
  setActivePeerId: (id: string | null) => void
}) {
  const session = usePresenceSession({
    token,
    myId: user.id,
    publicKey,
    privateKey,
    activePeerId,
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [nearbyMode, setNearbyMode] = useState(false)
  const [invitesMode, setInvitesMode] = useState(false)

  const selfImage = session.avatars[user.id]?.imageB64

  async function onPickAvatar(file: File | undefined) {
    if (!file) return
    setAvatarError(null)
    setAvatarBusy(true)
    try {
      const b64 = await fileToAvatarJpeg(file)
      await session.setSelfAvatar(b64)
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not set photo')
    } finally {
      setAvatarBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (session.superseded) {
    return (
      <div className="app-frame">
        <div className="empty-state centered">
          <p className="brand">Presence</p>
          <p className="empty-state-lead">Signed in somewhere else</p>
          <p className="empty-state-sub">
            This account is open in another tab or device. Presence allows one
            at a time.
          </p>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => window.location.reload()}
          >
            Use it here
          </button>
        </div>
      </div>
    )
  }

  if (invitesMode && token && user.role === 'hub') {
    return (
      <div className="app-frame app-frame--split">
        <div className="nearby-page">
          <header className="nearby-header">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setInvitesMode(false)}
            >
              Back
            </button>
            <h1>Invites</h1>
          </header>
          <InvitesPanel token={token} />
        </div>
      </div>
    )
  }
  if (nearbyMode && publicKey && privateKey) {
    return (
      <div className="app-frame app-frame--split">
        <NearbyCallPage
          userId={user.id}
          displayName={user.display_name}
          publicKey={publicKey}
          privateKey={privateKey}
          onBack={() => setNearbyMode(false)}
        />
      </div>
    )
  }

    const activePeer = activePeerId
    ? (session.peersById[activePeerId] ?? null)
    : null

  return (
    <div
      className={`app-frame app-frame--split${activePeer ? ' app-frame--chat-open' : ''}`}
    >
      <aside className="sidebar">
        <header className="list-header">
          <div className="list-header-left">
            <button
              type="button"
              className="self-avatar-btn"
              aria-label={
                selfImage ? 'Change profile photo' : 'Add profile photo'
              }
              disabled={avatarBusy}
              onClick={() => fileRef.current?.click()}
            >
              <Avatar user={user} size={44} imageB64={selfImage} />
            </button>
            <div>
              <p className="brand">Presence</p>
              <h1>Friends</h1>
            </div>
          </div>
          <div className="list-header-actions">
            {selfImage && (
              <button
                type="button"
                className="ghost-btn"
                disabled={avatarBusy}
                onClick={() => void session.clearSelfAvatar()}
              >
                Remove photo
              </button>
            )}
            {user.role === 'hub' && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setInvitesMode(true)}
              >
                Invites
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setNearbyMode(true)}
            >
              Nearby
            </button>
            <ThemeToggle />
            <button type="button" className="ghost-btn" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => void onPickAvatar(e.target.files?.[0])}
        />
        <p className="list-status">
          {session.connected ? 'Live' : 'Reconnecting…'}
          {avatarBusy ? ' · Updating photo…' : ''}
        </p>
        {avatarError && <p className="list-avatar-error">{avatarError}</p>}
        <ul className="friend-list">
          {session.peers.map((peer) => {
            const hasUnread = !!session.unread[peer.id]
            const isActive = activePeerId === peer.id
            return (
              <li key={peer.id}>
                <button
                  type="button"
                  className={`friend-row${peer.online ? '' : ' friend-row--offline'}${hasUnread ? ' friend-row--unread' : ''}${isActive ? ' friend-row--active' : ''}`}
                  onClick={() => setActivePeerId(peer.id)}
                >
                  <div className="friend-avatar-wrap">
                    <Avatar
                      user={peer}
                      dimmed={!peer.online}
                      imageB64={session.avatars[peer.id]?.imageB64}
                    />
                    {hasUnread && <span className="unread-dot" aria-hidden />}
                  </div>
                  <div className="friend-meta">
                    <span className="friend-name">{peer.display_name}</span>
                    <span className="friend-state">
                      {hasUnread
                        ? 'New message'
                        : peer.online
                          ? 'Present'
                          : 'Unavailable'}
                    </span>
                  </div>
                </button>
              </li>
            )
          })}
          {session.peers.length === 0 && (
            <li className="empty-state">
              <p className="empty-state-sub">
                {session.connected
                  ? 'No one in your circle yet.'
                  : 'Connecting…'}
              </p>
            </li>
          )}
        </ul>
      </aside>

      <main className="chat-pane">
        {activePeer ? (
          <ChatView
            me={user}
            peer={activePeer}
            peerImageB64={session.avatars[activePeer.id]?.imageB64}
            messages={session.messages[activePeer.id] ?? []}
            typing={!!session.typing[activePeer.id]}
            leaving={session.leavingPeer === activePeer.id}
            canEncrypt={!!session.sessionKeys[activePeer.id]}
            reactions={session.reactions}
            onBack={() => setActivePeerId(null)}
            onSend={(text) => session.sendMessage(activePeer.id, text)}
            onSendSnap={(imageB64, timerSec) =>
              session.sendSnap(activePeer.id, imageB64, timerSec)
            }
            onSendVoice={(audioB64, mime, durationMs) =>
              session.sendVoice(activePeer.id, audioB64, mime, durationMs)
            }
            onConsumeSnap={(msgId) =>
              session.consumeSnap(activePeer.id, msgId)
            }
            onTyping={(active) => session.sendTyping(activePeer.id, active)}
            onReact={(msgId, emoji) =>
              session.sendReaction(activePeer.id, msgId, emoji)
            }
          />
        ) : (
          <div className="chat-pane-empty">
            <p className="brand">Presence</p>
            <p className="empty-state-lead">Pick someone who is present</p>
            <p className="empty-state-sub">
              Messages only live while both of you are here.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}