import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'
import {
  checkApkUpdate,
  openApkDownload,
  wasUpdateDismissed,
  type ApkUpdateInfo,
} from '../apkUpdate'
import { fileToAvatarJpeg } from '../avatarImage'
import { ApkUpdateBanner } from '../components/ApkUpdateBanner'
import { Avatar } from '../components/Avatar'
import { BrandMark } from '../components/BrandMark'
import { ChatView } from '../components/ChatView'
import { ThemeToggle } from '../components/ThemeToggle'
import { InvitesPanel } from '../components/InvitesPanel'
import { MembersPanel } from '../components/MembersPanel'
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
  const [membersMode, setMembersMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apkUpdate, setApkUpdate] = useState<ApkUpdateInfo | null>(null)
  const [apkBannerVisible, setApkBannerVisible] = useState(false)

  useEffect(() => {
    let cancelled = false
    void checkApkUpdate()
      .then((info) => {
        if (cancelled || !info) return
        setApkUpdate(info)
        if (!wasUpdateDismissed(info.latestBuild)) {
          setApkBannerVisible(true)
        }
      })
      .catch(() => {
        /* offline / rate limit — ignore */
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  if (membersMode && token && user.role === 'hub') {
    return (
      <div className="app-frame app-frame--split">
        <div className="nearby-page">
          <header className="nearby-header">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setMembersMode(false)}
            >
              Back
            </button>
            <h1>Members</h1>
          </header>
          <MembersPanel token={token} />
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
        {apkBannerVisible && apkUpdate && (
          <ApkUpdateBanner
            update={apkUpdate}
            onDismiss={() => setApkBannerVisible(false)}
          />
        )}
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
              <Avatar user={user} size={36} imageB64={selfImage} />
            </button>
            <div className="list-header-identity">
              <BrandMark size={22} />
              <p className="list-status">
                <span
                  className={`status-dot${session.connected ? ' status-dot--live' : ''}`}
                  aria-hidden
                />
                {session.connected ? 'Live' : 'Reconnecting…'}
                {avatarBusy ? ' · Updating…' : ''}
              </p>
            </div>
          </div>
          <div className="list-header-actions">
            {user.role === 'hub' && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Members"
                  title="Members"
                  onClick={() => setMembersMode(true)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                    <path
                      d="M8 12a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 8 12Zm8 0a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 16 12Z"
                      fill="currentColor"
                    />
                    <path
                      d="M1.5 19c0-2.4 2.7-4 6.5-4s6.5 1.6 6.5 4M10 19c.4-1.7 2.2-3 5-3.5 2.6.3 5 1.6 5 3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Invites"
                  title="Invites"
                  onClick={() => setInvitesMode(true)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                    <path
                      d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.3 0-6 1.7-6 3.8V20h12v-2.2c0-2.1-2.7-3.8-6-3.8Z"
                      fill="currentColor"
                    />
                    <path
                      d="M19 8v3m0 0v3m0-3h3m-3 0h-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label="Nearby"
              title="Nearby"
              onClick={() => setNearbyMode(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="10" r="2.25" fill="currentColor" />
              </svg>
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
        <footer
          className={`sidebar-settings${settingsOpen ? ' sidebar-settings--open' : ''}`}
        >
          <button
            type="button"
            className="sidebar-settings-toggle"
            aria-expanded={settingsOpen}
            aria-controls="sidebar-settings-panel"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <span>Settings</span>
            <svg
              className="sidebar-settings-chevron"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                d="M6 9l6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {settingsOpen && (
            <div id="sidebar-settings-panel" className="sidebar-settings-body">
              <div className="sidebar-settings-row">
                <span>Appearance</span>
                <ThemeToggle />
              </div>
              <a
                className="sidebar-settings-action"
                href="https://github.com/utdady/presence/releases/latest"
                target="_blank"
                rel="noreferrer"
              >
                Get latest Android APK
              </a>
              {apkUpdate && (
                <button
                  type="button"
                  className="sidebar-settings-action"
                  onClick={() => openApkDownload(apkUpdate.downloadUrl)}
                >
                  Update APK (build {apkUpdate.latestBuild})
                </button>
              )}
              {selfImage && (
                <button
                  type="button"
                  className="sidebar-settings-action"
                  disabled={avatarBusy}
                  onClick={() => void session.clearSelfAvatar()}
                >
                  Remove photo
                </button>
              )}
              <button
                type="button"
                className="sidebar-settings-action"
                onClick={logout}
              >
                Sign out
              </button>
            </div>
          )}
        </footer>
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
            <BrandMark size={28} />
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