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
import { VoiceBubble } from '../components/VoiceBubble'

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

      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          fingerprint={call.remoteFingerprint}
          recordingNote={call.recordingNote}
          fileTransfer={call.fileTransfer}
          onSend={(text) => void call.sendChat(text)}
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
        catchingUp={call.catchingUp}
        onAccept={() => void withMicPrime(() => void call.acceptCall())}
        onReject={() => void call.rejectCall()}
        onEnd={() => void call.endCall()}
        onToggleMute={call.toggleMute}
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
            <p className="empty-state-lead">Bluetooth Nearby</p>
            <p className="nearby-note">
              Offline Bluetooth chat needs the Android APK or Windows desktop
              app. This browser can only use an internet room as a fallback.
            </p>
          </div>

          <button
            type="button"
            className="ghost-btn"
            onClick={() => setShowOnlineRooms((v) => !v)}
          >
            {showOnlineRooms
              ? 'Hide internet fallback'
              : 'Need internet fallback?'}
          </button>

          {showOnlineRooms && (
            <>
              <p className="nearby-note">
                Room codes need the Presence server — not offline Bluetooth.
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
          <p className="nearby-note">Waiting for the other device…</p>
          <button type="button" className="ghost-btn" onClick={call.leaveRoom}>
            Cancel
          </button>
        </div>
      )}

      {CHAT_PHASES.has(call.phase) && (
        <NearbyChatPanel
          messages={call.messages}
          peerName={call.remoteName}
          fingerprint={call.remoteFingerprint}
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
            : 'Online room'
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

function NearbyChatPanel({
  messages,
  peerName,
  fingerprint,
  recordingNote,
  fileTransfer,
  onSend,
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
  recordingNote?: boolean
  fileTransfer?: { name: string; sent: number; total: number } | null
  onSend: (text: string) => void
  onStartVoice?: () => void
  onStopVoice?: () => void
  onCancelVoice?: () => void
  onPickFile?: () => void
  onCancelFile?: () => void
  onLeave?: () => void
}) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <div className="nearby-chat nearby-chat--main">
      <div className="nearby-chat-toolbar">
        <div>
          <p className="nearby-chat-label">
            {peerName ? peerName : 'Chat'}
          </p>
          {fingerprint && (
            <p className="nearby-fingerprint">Key {fingerprint}</p>
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
            >
              {!m.mine && (
                <span className="nearby-chat-from">{m.fromName}</span>
              )}
              {m.kind === 'voice' && m.audio_b64 && m.audio_mime ? (
                <VoiceBubble
                  audioB64={m.audio_b64}
                  mime={m.audio_mime}
                  durationMs={m.duration_ms ?? 1000}
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
            </div>
          ))
        )}
      </div>
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
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
