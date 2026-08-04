import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  markPrimeSeen,
  shouldShowPrime,
} from '../featurePermissions'
import { Avatar } from './Avatar'
import { PermissionPrime } from './PermissionPrime'
import { SnapCapture } from './SnapCapture'
import { SnapViewer } from './SnapViewer'
import { VoiceBubble } from './VoiceBubble'
import type { ChatMessage, SnapTimerSec, UserPublic } from '../types'
import {
  VOICE_MAX_B64_CHARS,
  VOICE_MAX_MS,
  blobToBase64,
  formatDuration,
  measureBlobDurationMs,
  pickRecorderMime,
} from '../voiceAudio'

interface ChatViewProps {
  me: UserPublic
  peer: UserPublic
  peerImageB64?: string | null
  messages: ChatMessage[]
  typing: boolean
  leaving: boolean
  canEncrypt: boolean
  reactions: readonly string[]
  onSend: (text: string) => void
  onSendSnap: (imageB64: string, timerSec: SnapTimerSec) => void
  onSendVoice: (audioB64: string, mime: string, durationMs: number) => void
  onConsumeSnap: (msgId: string) => void
  onTyping: (active: boolean) => void
  onReact: (msgId: string, emoji: string) => void
  onBack?: () => void
}

export function ChatView({
  me,
  peer,
  peerImageB64,
  messages,
  typing,
  leaving,
  canEncrypt,
  reactions,
  onSend,
  onSendSnap,
  onSendVoice,
  onConsumeSnap,
  onTyping,
  onReact,
  onBack,
}: ChatViewProps) {
  const [text, setText] = useState('')
  const [activeMsg, setActiveMsg] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [viewingSnapId, setViewingSnapId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [recError, setRecError] = useState<string | null>(null)
  const [micPrime, setMicPrime] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const typingTimer = useRef<number | undefined>(undefined)
  const viewingSnapIdRef = useRef<string | null>(null)
  viewingSnapIdRef.current = viewingSnapId

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startedAtRef = useRef(0)
  const maxTimerRef = useRef<number | undefined>(undefined)
  const tickRef = useRef<number | undefined>(undefined)
  const mimeRef = useRef('audio/webm')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, typing])

  useEffect(() => {
    return () => {
      const id = viewingSnapIdRef.current
      if (id) onConsumeSnap(id)
      stopMicTracks()
    }
  }, [onConsumeSnap])

  useEffect(() => {
    if (leaving && viewingSnapId) {
      onConsumeSnap(viewingSnapId)
      setViewingSnapId(null)
    }
    if (leaving && recording) {
      void cancelRecording()
    }
  }, [leaving, viewingSnapId, recording, onConsumeSnap])

  const online = peer.online && !leaving
  const unavailable = !online
  const viewingMsg = viewingSnapId
    ? messages.find((m) => m.id === viewingSnapId)
    : null

  function stopMicTracks() {
    if (maxTimerRef.current) window.clearTimeout(maxTimerRef.current)
    if (tickRef.current) window.clearInterval(tickRef.current)
    maxTimerRef.current = undefined
    tickRef.current = undefined
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  async function startRecording() {
    if (unavailable || !canEncrypt || recording) return
    setRecError(null)
    if (await shouldShowPrime('microphone')) {
      setMicPrime(true)
      return
    }
    await beginRecording()
  }

  async function beginRecording() {
    if (unavailable || !canEncrypt || recording) return
    setRecError(null)
    const mime = pickRecorderMime()
    if (!mime) {
      setRecError('Voice recording not supported here')
      return
    }
    mimeRef.current = mime
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const rec = new MediaRecorder(stream, { mimeType: mime })
      chunksRef.current = []
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      rec.onstop = () => {
        void finishRecording()
      }
      mediaRecorderRef.current = rec
      startedAtRef.current = Date.now()
      setRecElapsed(0)
      setRecording(true)
      // Single blob on stop — timeslices often yield unplayable WebM on the receiver
      rec.start()
      tickRef.current = window.setInterval(() => {
        setRecElapsed(Date.now() - startedAtRef.current)
      }, 200)
      maxTimerRef.current = window.setTimeout(() => {
        stopRecording()
      }, VOICE_MAX_MS)
    } catch {
      stopMicTracks()
      setRecError('Microphone access denied or unavailable')
      setRecording(false)
    }
  }

  function stopRecording() {
    const rec = mediaRecorderRef.current
    if (!rec || rec.state === 'inactive') {
      stopMicTracks()
      setRecording(false)
      return
    }
    rec.stop()
  }

  async function cancelRecording() {
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      rec.stop()
    }
    chunksRef.current = []
    stopMicTracks()
    setRecording(false)
    setRecElapsed(0)
  }

  async function finishRecording() {
    const wallMs = Math.max(1000, Date.now() - startedAtRef.current)
    const chunks = chunksRef.current
    const mime = mimeRef.current
    stopMicTracks()
    setRecording(false)
    setRecElapsed(0)
    if (chunks.length === 0) {
      setRecError('Nothing recorded')
      return
    }
    try {
      const blob = new Blob(chunks, { type: mime })
      if (blob.size < 64) {
        setRecError('Recording too short — try again')
        return
      }
      const durationMs = await measureBlobDurationMs(blob, wallMs)
      const b64 = await blobToBase64(blob)
      if (b64.length > VOICE_MAX_B64_CHARS) {
        setRecError('Voice note too long — keep it under a minute')
        return
      }
      onSendVoice(b64, mime, durationMs)
    } catch {
      setRecError('Failed to send voice note')
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || unavailable || !canEncrypt) return
    onSend(trimmed)
    setText('')
    onTyping(false)
  }

  function handleChange(value: string) {
    setText(value)
    if (!online || !canEncrypt) return
    onTyping(true)
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    typingTimer.current = window.setTimeout(() => onTyping(false), 1200)
  }

  function openSnap(m: ChatMessage) {
    if (m.kind !== 'snap' || m.opened || !m.image_b64) return
    if (m.from === me.id) return
    setViewingSnapId(m.id)
  }

  function closeViewer() {
    if (viewingSnapId) onConsumeSnap(viewingSnapId)
    setViewingSnapId(null)
  }

  if (capturing) {
    return (
      <SnapCapture
        onClose={() => setCapturing(false)}
        onSend={(imageB64, timerSec) => {
          onSendSnap(imageB64, timerSec)
          setCapturing(false)
        }}
      />
    )
  }

  if (micPrime) {
    return (
      <PermissionPrime
        feature="microphone"
        onNotNow={() => setMicPrime(false)}
        onContinue={() => {
          markPrimeSeen('microphone')
          setMicPrime(false)
          void beginRecording()
        }}
      />
    )
  }

  return (
    <div className={`chat${leaving ? ' chat--leaving' : ''}`}>
      <header className="chat-header">
        {onBack && (
          <button type="button" className="ghost-btn" onClick={onBack} aria-label="Back">
            ←
          </button>
        )}
        <Avatar
          user={peer}
          size={36}
          dimmed={unavailable}
          imageB64={peerImageB64}
        />
        <div className="chat-header-text">
          <div className="chat-title-row">
            <h1>{peer.display_name}</h1>
            <span className="lock" title="End-to-end encrypted" aria-label="Encrypted">
              <LockIcon />
            </span>
          </div>
          <p className="chat-sub">
            {leaving
              ? 'Going offline…'
              : online
                ? canEncrypt
                  ? 'Present'
                  : 'Establishing session…'
                : 'Unavailable'}
          </p>
        </div>
      </header>

      <div className="chat-body">
        {unavailable && messages.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-lead">
              {peer.display_name} is currently unavailable
            </p>
            <p className="empty-state-sub">
              Messages exist only while you are both here.
            </p>
          </div>
        ) : (
          <ul className="msg-list">
            {messages.map((m) => {
              const mine = m.from === me.id
              const isSnap = m.kind === 'snap'
              const isVoice = m.kind === 'voice'
              return (
                <li
                  key={m.id}
                  className={`msg${mine ? ' msg--mine' : ''}`}
                  onClick={() => {
                    if (isSnap) {
                      openSnap(m)
                      return
                    }
                    if (isVoice) return
                    setActiveMsg((id) => (id === m.id ? null : m.id))
                  }}
                >
                  <div
                    className={`msg-bubble${isSnap ? ' msg-bubble--snap' : ''}${isVoice ? ' msg-bubble--voice' : ''}`}
                  >
                    {isSnap ? (
                      <SnapBubble
                        mine={mine}
                        opened={!!m.opened}
                        hasImage={!!m.image_b64}
                        timerSec={m.timer_sec ?? 0}
                      />
                    ) : isVoice && m.audio_b64 && m.audio_mime ? (
                      <VoiceBubble
                        audioB64={m.audio_b64}
                        mime={m.audio_mime}
                        durationMs={m.duration_ms ?? 0}
                      />
                    ) : (
                      <p>{m.text}</p>
                    )}
                    {mine && m.status !== 'sent' && m.status !== 'sending' && (
                      <span className="msg-status">{m.status}</span>
                    )}
                    {!isSnap &&
                      !isVoice &&
                      Object.keys(m.reactions).length > 0 && (
                        <div className="msg-reactions">
                          {Object.values(m.reactions).map((emoji, i) => (
                            <span key={`${m.id}-r-${i}`}>{emoji}</span>
                          ))}
                        </div>
                      )}
                  </div>
                  {!isSnap &&
                    !isVoice &&
                    activeMsg === m.id &&
                    online &&
                    canEncrypt && (
                      <div className="reaction-picker">
                        {reactions.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              onReact(m.id, emoji)
                              setActiveMsg(null)
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                </li>
              )
            })}
            {typing && online && (
              <li className="typing-indicator">
                {peer.display_name} is typing…
              </li>
            )}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>

      {recording ? (
        <div className="composer composer--rec">
          <span className="rec-dot" aria-hidden />
          <span className="rec-label">Recording {formatDuration(recElapsed)}</span>
          <button type="button" className="ghost-btn" onClick={() => void cancelRecording()}>
            Cancel
          </button>
          <button type="button" className="snap-send-btn" onClick={stopRecording}>
            Send
          </button>
        </div>
      ) : (
        <form className="composer" onSubmit={handleSubmit}>
          <button
            type="button"
            className="composer-cam"
            aria-label="Take a snap"
            disabled={unavailable || !canEncrypt}
            onClick={() => setCapturing(true)}
          >
            <CamIcon />
          </button>
          <button
            type="button"
            className="composer-cam"
            aria-label="Record voice message"
            disabled={unavailable || !canEncrypt}
            onClick={() => void startRecording()}
          >
            <MicIcon />
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={
              unavailable
                ? 'Waiting for presence…'
                : canEncrypt
                  ? 'Message'
                  : 'Connecting…'
            }
            disabled={unavailable || !canEncrypt}
            autoComplete="off"
          />
          <button type="submit" disabled={unavailable || !canEncrypt || !text.trim()}>
            Send
          </button>
        </form>
      )}
      {recError && <p className="composer-error">{recError}</p>}

      {viewingMsg?.image_b64 && (
        <SnapViewer
          imageB64={viewingMsg.image_b64}
          timerSec={viewingMsg.timer_sec ?? 0}
          peerName={peer.display_name}
          onClose={closeViewer}
        />
      )}
    </div>
  )
}

function SnapBubble({
  mine,
  opened,
  hasImage,
  timerSec,
}: {
  mine: boolean
  opened: boolean
  hasImage: boolean
  timerSec: SnapTimerSec
}) {
  if (mine) {
    return (
      <p className="snap-tile-label">
        Photo{timerSec > 0 ? ` · ${timerSec}s` : ''}
      </p>
    )
  }
  if (opened || !hasImage) {
    return <p className="snap-tile-label snap-tile-label--opened">Opened</p>
  }
  return (
    <p className="snap-tile-label">
      Photo{timerSec > 0 ? ` · ${timerSec}s` : ' · Tap to view'}
    </p>
  )
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 11V8a5 5 0 0 1 10 0v3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  )
}

function CamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8h3l1.5-2h7L17 8h3v11H4V8z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.5" r="3.25" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M6 11a6 6 0 0 0 12 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 17v3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  )
}
