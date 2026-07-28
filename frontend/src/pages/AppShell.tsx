import { useRef, useState } from 'react'
import { useAuth } from '../auth'
import { fileToAvatarJpeg } from '../avatarImage'
import { Avatar } from '../components/Avatar'
import { ChatView } from '../components/ChatView'
import { ThemeToggle } from '../components/ThemeToggle'
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

  const activePeer = activePeerId
    ? session.peersById[activePeerId] ?? null
    : null

  if (activePeer) {
    return (
      <div className="app-frame">
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
          onConsumeSnap={(msgId) => session.consumeSnap(activePeer.id, msgId)}
          onTyping={(active) => session.sendTyping(activePeer.id, active)}
          onReact={(msgId, emoji) =>
            session.sendReaction(activePeer.id, msgId, emoji)
          }
        />
      </div>
    )
  }

  return (
    <div className="app-frame">
      <header className="list-header">
        <div className="list-header-left">
          <button
            type="button"
            className="self-avatar-btn"
            aria-label={selfImage ? 'Change profile photo' : 'Add profile photo'}
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
          return (
            <li key={peer.id}>
              <button
                type="button"
                className={`friend-row${peer.online ? '' : ' friend-row--offline'}${hasUnread ? ' friend-row--unread' : ''}`}
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
    </div>
  )
}
