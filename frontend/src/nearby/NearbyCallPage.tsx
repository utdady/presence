import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  markPrimeSeen,
  shouldShowPrime,
} from '../featurePermissions'
import type { NearbyCallPhase, NearbyChatMessage } from './types'
import { nearbyTransport, type NearbyTransport } from './capability'
import { useLanNearbyCall } from './useLanNearbyCall'
import { useNearbyCall } from './useNearbyCall'
import { PermissionPrime } from '../components/PermissionPrime'
import { CallStage } from '../components/CallStage'
import {
  ComposerMediaButton,
  ComposerMediaTray,
  useComposerMediaTray,
} from '../components/ComposerMediaTray'
import { EmojiPicker } from '../components/EmojiPicker'
import { VoiceBubble } from '../components/VoiceBubble'
import { QUICK_REACTIONS } from '../emojiData'
import { useEdgeSwipeBack } from '../navigation/useBackStack'

interface Props {
  userId: string
  displayName: string
  publicKey: string
  privateKey: string
  onBack: () => void
}

const CHAT_PHASES = new Set<NearbyCallPhase>([
  'ready',
  'outgoing',
  'incoming',
  'in_call',
])

export function NearbyCallPage(props: Props) {
  const [transport, setTransport] = useState<NearbyTransport | null>(null)

  useEffect(() => {
    void nearbyTransport().then(setTransport)
  }, [])

  if (transport === null) {
    return (
      <div className="nearby-page">
        <header className="nearby-header">
          <button type="button" className="ghost-btn" onClick={props.onBack}>
            Back
          </button>
          <h1>Nearby</h1>
        </header>
        <p className="nearby-status">Checking device…</p>
      </div>
    )
  }

  if (transport === 'native') {
    return <NativeNearbyUI {...props} />
  }

  return <LanNearbyUI {...props} />
}

function NativeNearbyUI({
  userId,
  displayName,
  publicKey,
  privateKey,
  onBack,
}: Props) {
  const call = useNearbyCall({ userId, displayName, publicKey, privateKey })
  const audioRef = useRef<HTMLAudioElement>(null)
  const [nearbyPrime, setNearbyPrime] = useState(false)
  const [micPrime, setMicPrime] = useState(false)
  const pendingMicAction = useRef<null | (() => void)>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEdgeSwipeBack(true, () => {
    void call.stopScanning()
    onBack()
  })

  useEffect(() => {
    call.setRemoteAudioEl(audioRef.current)
  }, [call])

  async function onFindNearby() {
    if (await shouldShowPrime('nearby')) {
      setNearbyPrime(true)
      return
    }
    void call.startScanning()
  }

  async function withMicPrime(action: () => void) {
    if (await shouldShowPrime('microphone')) {
      pendingMicAction.current = action
      setMicPrime(true)
      return
    }
    action()
  }

  if (nearbyPrime) {
    return (
      <div className="nearby-page">
        <PermissionPrime
          feature="nearby"
          onNotNow={() => setNearbyPrime(false)}
          onContinue={() => {
            markPrimeSeen('nearby')
            setNearbyPrime(false)
            void call.startScanning()
          }}
        />
      </div>
    )
  }

  if (micPrime) {
    return (
      <div className="nearby-page">
        <PermissionPrime
          feature="microphone"
          onNotNow={() => {
            pendingMicAction.current = null
            setMicPrime(false)
          }}
          onContinue={() => {
            markPrimeSeen('microphone')
            setMicPrime(false)
            pendingMicAction.current?.()
            pendingMicAction.current = null
          }}
        />
      </div>
    )
  }

  return (
    <div className="nearby-page nearby-page--chat">
      <header className="nearby-header">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            void call.stopScanning()
            onBack()
          }}
        >
          Back
        </button>
        <h1>
          {CHAT_PHASES.has(call.phase)
            ? (call.remoteName ?? 'Nearby')
            : 'Nearby'}
        </h1>
        {call.phase === 'ready' && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void withMicPrime(() => void call.startCall())}
          >
            Call
          </button>
        )}
      </header>
      <audio ref={audioRef} autoPlay playsInline />
      <p className="nearby-status">{call.status || 'Idle'}</p>
      {call.catchingUp && (
        <p className="nearby-note">Catching up on call audio…</p>
      )}
      {call.error && <p className="form-error">{call.error}</p>}

      {call.phase === 'idle' && (
        <div className="nearby-actions">
          <p className="nearby-note" style={{ padding: '0 0.25rem' }}>
            Bluetooth only — no Wi‑Fi or internet. You appear as{' '}
            <strong>Presence/{displayName}</strong>. Keep Bluetooth on. If only
            one side sees the other, connect from that side.
          </p>
          <button type="button" onClick={() => void onFindNearby()}>
            Find nearby
          </button>
        </div>
      )}

      {(call.phase === 'scanning' || call.phase === 'connecting') && (
        <div className="nearby-panel">
          <p className="nearby-note">
            Visible as Presence/{displayName}. Only one side taps Connect.
          </p>
          <ul className="nearby-peer-list">
            {call.peers.map((peer) => (
              <li key={peer.id}>
                <button
                  type="button"
                  className="friend-row"
                  onClick={() => void call.connectTo(peer)}
                >
                  <div className="friend-meta">
                    <span className="friend-name">{peer.name}</span>
                    <span className="friend-state">Tap to connect</span>
                  </div>
                </button>
              </li>
            ))}
            {call.peers.length === 0 && (
              <li className="nearby-note">Scanning over Bluetooth…</li>
            )}
          </ul>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void call.stopScanning()}
          >
            Stop
          </button>
        </div>
      )}

      {call.phase === 'verify' && (
        <div className="nearby-panel nearby-verify">
          <p className="empty-state-lead">
            {call.pinStatus === 'changed'
              ? 'Key changed'
              : 'Verify this device'}
          </p>
          <p className="nearby-note">
            Compare this fingerprint with the one on{' '}
            {call.remoteName ?? 'their'} screen. Only confirm if they match.
          </p>
          <p className="nearby-verify-fp">{call.remoteFingerprint}</p>
          <button type="button" onClick={call.confirmPeer}>
            Confirm — same key on both screens
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={call.rejectPeer}
          >
            Disconnect
          </button>
        </div>
      )}

      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          fingerprint={call.remoteFingerprint}
          verified={call.pinStatus === 'known'}
          recordingNote={call.recordingNote}
          fileTransfer={call.fileTransfer}
          onSend={(text, replyTo) => void call.sendChat(text, replyTo)}
          onReact={(msgId, emoji) => void call.sendReaction(msgId, emoji)}
          onSendSticker={(b64, mime) => void call.sendStickerMsg(b64, mime)}
          onStartVoice={() =>
            void withMicPrime(() => void call.startVoiceNote())
          }
          onStopVoice={() => void call.stopVoiceNote()}
          onCancelVoice={call.cancelVoiceNote}
          onPickFile={() => fileRef.current?.click()}
          onCancelFile={call.cancelFile}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void call.sendFile(f)
        }}
      />

      <CallStage
        open
        phase={call.phase}
        peerName={call.remoteName ?? 'Peer'}
        subtitle={
          call.remoteFingerprint
            ? `Key ${call.remoteFingerprint}`
            : 'Bluetooth'
        }
        muted={call.muted}
        speakerOn={call.speakerOn}
        speakerAvailable={call.speakerAvailable}
        catchingUp={call.catchingUp}
        onAccept={() => void withMicPrime(() => void call.acceptCall())}
        onReject={() => void call.rejectCall()}
        onEnd={() => void call.endCall()}
        onToggleMute={call.toggleMute}
        onToggleSpeaker={call.toggleSpeaker}
      />
    </div>
  )
}

function LanNearbyUI({
  userId,
  displayName,
  publicKey,
  privateKey,
  onBack,
}: Props) {
  const call = useLanNearbyCall({ userId, displayName, publicKey, privateKey })
  const audioRef = useRef<HTMLAudioElement>(null)
  const [joinCode, setJoinCode] = useState('')
  const [showOnlineRooms, setShowOnlineRooms] = useState(false)
  const [micPrime, setMicPrime] = useState(false)
  const pendingMicAction = useRef<null | (() => void)>(null)

  useEdgeSwipeBack(true, () => {
    call.leaveRoom()
    onBack()
  })

  useEffect(() => {
    call.setRemoteAudioEl(audioRef.current)
  }, [call])

  async function withMicPrime(action: () => void) {
    if (await shouldShowPrime('microphone')) {
      pendingMicAction.current = action
      setMicPrime(true)
      return
    }
    action()
  }

  if (micPrime) {
    return (
      <div className="nearby-page">
        <PermissionPrime
          feature="microphone"
          onNotNow={() => {
            pendingMicAction.current = null
            setMicPrime(false)
          }}
          onContinue={() => {
            markPrimeSeen('microphone')
            setMicPrime(false)
            pendingMicAction.current?.()
            pendingMicAction.current = null
          }}
        />
      </div>
    )
  }

  return (
    <div className="nearby-page nearby-page--chat">
      <header className="nearby-header">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            call.leaveRoom()
            onBack()
          }}
        >
          Back
        </button>
        <h1>
          {CHAT_PHASES.has(call.phase)
            ? (call.remoteName ?? 'Nearby')
            : 'Nearby'}
        </h1>
        {call.phase === 'ready' && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void withMicPrime(() => void call.startCall())}
          >
            Call
          </button>
        )}
      </header>
      <audio ref={audioRef} autoPlay playsInline />
      <p className="nearby-status">{call.status || 'Idle'}</p>
      {call.error && <p className="form-error">{call.error}</p>}

      {call.phase === 'idle' && (
        <div className="nearby-actions">
          <div className="nearby-cta">
            <p className="empty-state-lead">Nearby</p>
            <p className="nearby-note">
              Fully offline chat needs Bluetooth (Android APK or Windows app).
              This browser can only start an internet room — the server is used
              for the room code and signaling; call audio stays peer-to-peer.
            </p>
          </div>

          <button
            type="button"
            className="ghost-btn"
            onClick={() => setShowOnlineRooms((v) => !v)}
          >
            {showOnlineRooms
              ? 'Hide internet room'
              : 'Start internet room (needs online)'}
          </button>

          {showOnlineRooms && (
            <>
              <p className="nearby-note">
                Needs internet to create/join. Not the same as offline Bluetooth.
              </p>
              <button type="button" onClick={() => void call.createRoom()}>
                Create room
              </button>
              <div className="invites-create">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Room code"
                  maxLength={8}
                  autoCapitalize="characters"
                />
                <button
                  type="button"
                  onClick={() => void call.joinRoom(joinCode)}
                >
                  Join
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {(call.phase === 'scanning' || call.phase === 'connecting') && (
        <div className="nearby-panel nearby-ready">
          {call.roomCode && (
            <p className="empty-state-lead" style={{ letterSpacing: '0.2em' }}>
              {call.roomCode}
            </p>
          )}
          <p className="nearby-note">
            Waiting for the other device… (internet needed to start this room)
          </p>
          <button type="button" className="ghost-btn" onClick={call.leaveRoom}>
            Cancel
          </button>
        </div>
      )}

      {call.phase === 'verify' && (
        <div className="nearby-panel nearby-verify">
          <p className="empty-state-lead">
            {call.pinStatus === 'changed'
              ? 'Key changed'
              : 'Verify this device'}
          </p>
          <p className="nearby-note">
            Compare this fingerprint with the one on{' '}
            {call.remoteName ?? 'their'} screen. Only confirm if they match.
          </p>
          <p className="nearby-verify-fp">{call.remoteFingerprint}</p>
          <button type="button" onClick={call.confirmPeer}>
            Confirm — same key on both screens
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={call.rejectPeer}
          >
            Leave room
          </button>
        </div>
      )}

      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          fingerprint={call.remoteFingerprint}
          verified={call.pinStatus === 'known'}
          onSend={call.sendChat}
          onLeave={call.leaveRoom}
        />
      )}

      <CallStage
        open
        phase={call.phase}
        peerName={call.remoteName ?? 'Peer'}
        subtitle={
          call.remoteFingerprint
            ? `Key ${call.remoteFingerprint}`
            : 'Internet room'
        }
        muted={call.muted}
        onAccept={() => void withMicPrime(() => void call.acceptCall())}
        onReject={() => void call.rejectCall()}
        onEnd={() => void call.endCall()}
        onToggleMute={call.toggleMute}
      />
    </div>
  )
}

type NearbyReply = { msg_id: string; preview: string; from: string }

function NearbyChatPanel({
  messages,
  peerName,
  fingerprint,
  verified,
  recordingNote,
  fileTransfer,
  onSend,
  onReact,
  onSendSticker,
  onStartVoice,
  onStopVoice,
  onCancelVoice,
  onPickFile,
  onCancelFile,
  onLeave,
}: {
  messages: NearbyChatMessage[]
  peerName: string | null
  fingerprint?: string | null
  verified?: boolean
  recordingNote?: boolean
  fileTransfer?: { name: string; sent: number; total: number } | null
  onSend: (text: string, replyTo?: NearbyReply) => void
  onReact?: (msgId: string, emoji: string) => void
  onSendSticker?: (imageB64: string, mime: string) => void
  onStartVoice?: () => void
  onStopVoice?: () => void
  onCancelVoice?: () => void
  onPickFile?: () => void
  onCancelFile?: () => void
  onLeave?: () => void
}) {
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<NearbyReply | null>(null)
  const mediaTray = useComposerMediaTray('emoji')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [reactMore, setReactMore] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text, replyTo ?? undefined)
    setDraft('')
    setReplyTo(null)
  }

  function previewOf(m: NearbyChatMessage): string {
    if (m.kind === 'sticker') return 'Sticker'
    if (m.kind === 'voice') return 'Voice message'
    if (m.kind === 'file') return m.file_name || 'File'
    return (m.text || '').slice(0, 80)
  }

  return (
    <div
      className="nearby-chat nearby-chat--main"
      onClick={() => setMenuId(null)}
    >
      <div className="nearby-chat-toolbar">
        <div>
          <p className="nearby-chat-label">
            {peerName ? peerName : 'Chat'}
          </p>
          {fingerprint && (
            <p className="nearby-fingerprint">
              Key {fingerprint}
              {verified ? ' · known' : ''}
            </p>
          )}
        </div>
        {onLeave && (
          <button type="button" className="ghost-btn" onClick={onLeave}>
            Leave
          </button>
        )}
      </div>
      <div className="nearby-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="nearby-note">Messages only while you stay connected.</p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`nearby-chat-bubble${m.mine ? ' nearby-chat-bubble--mine' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuId(m.id)
              }}
              onTouchStart={() => {
                longPressTimer.current = window.setTimeout(
                  () => setMenuId(m.id),
                  400,
                )
              }}
              onTouchEnd={() => {
                if (longPressTimer.current) {
                  window.clearTimeout(longPressTimer.current)
                  longPressTimer.current = undefined
                }
              }}
            >
              {!m.mine && (
                <span className="nearby-chat-from">{m.fromName}</span>
              )}
              {m.reply_to && (
                <div className="msg-reply-quote">
                  <span>{m.reply_to.preview}</span>
                </div>
              )}
              {m.kind === 'voice' && m.audio_b64 && m.audio_mime ? (
                <VoiceBubble
                  audioB64={m.audio_b64}
                  mime={m.audio_mime}
                  durationMs={m.duration_ms ?? 1000}
                />
              ) : m.kind === 'sticker' && m.image_b64 ? (
                <img
                  className="sticker-bubble-img"
                  src={`data:${m.sticker_mime || 'image/jpeg'};base64,${m.image_b64}`}
                  alt="Sticker"
                  draggable={false}
                />
              ) : m.kind === 'file' && m.file_b64 ? (
                <a
                  className="nearby-file-link"
                  href={`data:${m.file_mime || 'application/octet-stream'};base64,${m.file_b64}`}
                  download={m.file_name || 'file'}
                >
                  {m.file_name || 'File'}
                  {m.file_size != null
                    ? ` (${Math.round(m.file_size / 1024)} KB)`
                    : ''}
                </a>
              ) : (
                <p>{m.text}</p>
              )}
              {m.reactions && Object.keys(m.reactions).length > 0 && (
                <div className="msg-reactions">
                  {Object.values(m.reactions).map((emoji, i) => (
                    <span key={`${m.id}-r-${i}`}>{emoji}</span>
                  ))}
                </div>
              )}
              {menuId === m.id && (
                <div className="msg-context-menu">
                  {onReact && (
                    <>
                      <div className="reaction-picker">
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => {
                              onReact(m.id, emoji)
                              setMenuId(null)
                              setReactMore(false)
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="reaction-more"
                          onClick={() => setReactMore((v) => !v)}
                          aria-label="More reactions"
                        >
                          ＋
                        </button>
                      </div>
                      {reactMore && (
                        <EmojiPicker
                          onPick={(g) => {
                            onReact(m.id, g)
                            setMenuId(null)
                            setReactMore(false)
                          }}
                          onClose={() => setReactMore(false)}
                        />
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="msg-context-reply"
                    onClick={() => {
                      setReplyTo({
                        msg_id: m.id,
                        preview: previewOf(m),
                        from: m.fromName,
                      })
                      setMenuId(null)
                      setReactMore(false)
                    }}
                  >
                    Reply
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {replyTo && (
        <div className="composer-reply">
          <div>
            <span className="composer-reply-label">Replying</span>
            <span className="composer-reply-preview">{replyTo.preview}</span>
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setReplyTo(null)}
          >
            ×
          </button>
        </div>
      )}
      <ComposerMediaTray
        open={mediaTray.open}
        tab={mediaTray.tab}
        onTabChange={mediaTray.setTab}
        onClose={mediaTray.close}
        onPickEmoji={(g) => setDraft((d) => d + g)}
        onSendSticker={onSendSticker}
        stickersEnabled={!!onSendSticker}
      />
      {fileTransfer && (
        <div className="nearby-chat-transfer">
          <span>
            Sending {fileTransfer.name} (
            {Math.min(
              100,
              Math.round(
                (fileTransfer.sent / Math.max(1, fileTransfer.total)) * 100,
              ),
            )}
            %)
          </span>
          {onCancelFile && (
            <button type="button" className="ghost-btn" onClick={onCancelFile}>
              Cancel
            </button>
          )}
        </div>
      )}
      <form className="nearby-chat-compose" onSubmit={submit}>
        {onPickFile && (
          <button
            type="button"
            className="ghost-btn"
            onClick={onPickFile}
            aria-label="Attach file"
            disabled={!!fileTransfer}
          >
            ＋
          </button>
        )}
        {onStartVoice && onStopVoice && (
          <button
            type="button"
            className={`ghost-btn${recordingNote ? ' is-recording' : ''}`}
            onClick={() => {
              if (recordingNote) void onStopVoice()
              else void onStartVoice()
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onCancelVoice?.()
            }}
            aria-label={recordingNote ? 'Stop voice note' : 'Record voice note'}
          >
            {recordingNote ? '■' : '🎤'}
          </button>
        )}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          maxLength={2000}
          autoComplete="off"
        />
        <ComposerMediaButton
          open={mediaTray.open}
          onClick={mediaTray.toggle}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
