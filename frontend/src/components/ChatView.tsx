import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  markPrimeSeen,
  shouldShowPrime,
} from '../featurePermissions'
import { useEdgeSwipeBack } from '../navigation/useBackStack'
import type { ChatMessage, MessageReplyTo, SnapTimerSec, UserPublic } from '../types'
import {
  VOICE_MAX_B64_CHARS,
  VOICE_MAX_MS,
  blobToBase64,
  formatDuration,
  measureBlobDurationMs,
  pickRecorderMime,
} from '../voiceAudio'
import { Avatar } from './Avatar'
import {
  ComposerMediaButton,
  ComposerMediaTray,
  useComposerMediaTray,
} from './ComposerMediaTray'
import { EmojiPicker } from './EmojiPicker'
import { PermissionPrime } from './PermissionPrime'
import { SnapCapture } from './SnapCapture'
import { SnapViewer } from './SnapViewer'
import { VoiceBubble } from './VoiceBubble'

interface ChatViewProps {
  me: UserPublic
  peer: UserPublic
  peerImageB64?: string | null
  messages: ChatMessage[]
  typing: boolean
  leaving: boolean
  canEncrypt: boolean
  reactions: readonly string[]
  onSend: (text: string, replyTo?: MessageReplyTo) => void
  onSendSnap: (imageB64: string, timerSec: SnapTimerSec) => void
  onSendVoice: (audioB64: string, mime: string, durationMs: number) => void
  onSendSticker?: (imageB64: string, mime: string) => void
  onSendFile?: (file: File) => void
  onCancelFile?: () => void
  fileTransfer?: {
    name: string
    sent: number
    total: number
  } | null
  onStartCall?: (media: 'audio' | 'video') => void
  onConsumeSnap: (msgId: string) => void
  onTyping: (active: boolean) => void
  onReact: (msgId: string, emoji: string) => void
  onBack?: () => void
  /** Outgoing: I pinged them. */
  outgoingPingLabel?: string | null
  /** Incoming: they pinged me and I haven't ignored. */
  showIncomingPing?: boolean
  onReceivePing?: () => void
  onIgnorePing?: () => void
  onPingPeer?: () => void
  canPing?: boolean
}

function previewForMessage(m: ChatMessage): string {
  if (m.kind === 'sticker') return 'Sticker'
  if (m.kind === 'voice') return 'Voice message'
  if (m.kind === 'snap') return 'Snap'
  if (m.kind === 'file') return m.file_name || 'File'
  return (m.text || '').slice(0, 80)
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
  onSendSticker,
  onSendFile,
  onCancelFile,
  fileTransfer,
  onStartCall,
  onConsumeSnap,
  onTyping,
  onReact,
  onBack,
  outgoingPingLabel,
  showIncomingPing,
  onReceivePing,
  onIgnorePing,
  onPingPeer,
  canPing,
}: ChatViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null)
  const [reactMore, setReactMore] = useState(false)
  const [replyTo, setReplyTo] = useState<MessageReplyTo | null>(null)
  const mediaTray = useComposerMediaTray('emoji')
  const [capturing, setCapturing] = useState(false)
  const [viewingSnapId, setViewingSnapId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [recError, setRecError] = useState<string | null>(null)
  const [micPrime, setMicPrime] = useState(false)
  const [camPrime, setCamPrime] = useState(false)
  const [callMenuOpen, setCallMenuOpen] = useState(false)
  const [pingConfirm, setPingConfirm] = useState(false)
  const callHoldTimer = useRef<number | undefined>(undefined)
  const callHoldFired = useRef(false)
  const pendingMediaAction = useRef<'record' | 'audio' | 'video' | null>(null)
  const longPressTimer = useRef<number | undefined>(undefined)
  const swipeRef = useRef<{ id: string; x: number } | null>(null)

  useEdgeSwipeBack(
    !capturing && !mediaTray.open && !menuMsgId,
    onBack,
  )

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
  const recGenRef = useRef(0)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, typing])

  useEffect(() => {
    return () => {
      const id = viewingSnapIdRef.current
      if (id) onConsumeSnap(id)
      recGenRef.current += 1
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
      pendingMediaAction.current = 'record'
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
    const gen = ++recGenRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (gen !== recGenRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
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
      if (gen === recGenRef.current) {
        stopMicTracks()
        setRecError('Microphone access denied or unavailable')
        setRecording(false)
      }
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
    recGenRef.current += 1
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
    onSend(trimmed, replyTo ?? undefined)
    setText('')
    setReplyTo(null)
    onTyping(false)
  }

  function startReply(m: ChatMessage) {
    setReplyTo({
      msg_id: m.id,
      preview: previewForMessage(m),
      from: m.from,
    })
    setMenuMsgId(null)
    textInputRef.current?.focus()
  }

  function openMsgMenu(msgId: string) {
    setMenuMsgId(msgId)
    setReactMore(false)
  }

  function insertEmoji(glyph: string) {
    setText((t) => t + glyph)
    textInputRef.current?.focus()
  }

  async function beginVoiceCall() {
    if (!onStartCall) return
    if (await shouldShowPrime('microphone')) {
      pendingMediaAction.current = 'audio'
      setMicPrime(true)
      return
    }
    onStartCall('audio')
  }

  async function beginVideoCall() {
    if (!onStartCall) return
    if (await shouldShowPrime('camera')) {
      pendingMediaAction.current = 'video'
      setCamPrime(true)
      return
    }
    if (await shouldShowPrime('microphone')) {
      pendingMediaAction.current = 'video'
      setMicPrime(true)
      return
    }
    onStartCall('video')
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

  if (camPrime) {
    return (
      <PermissionPrime
        feature="camera"
        onNotNow={() => {
          pendingMediaAction.current = null
          setCamPrime(false)
        }}
        onContinue={() => {
          markPrimeSeen('camera')
          setCamPrime(false)
          if (pendingMediaAction.current === 'video') {
            void beginVideoCall()
          }
        }}
      />
    )
  }

  if (micPrime) {
    return (
      <PermissionPrime
        feature="microphone"
        onNotNow={() => {
          pendingMediaAction.current = null
          setMicPrime(false)
        }}
        onContinue={() => {
          markPrimeSeen('microphone')
          setMicPrime(false)
          const next = pendingMediaAction.current
          pendingMediaAction.current = null
          if (next === 'video') onStartCall?.('video')
          else if (next === 'audio') onStartCall?.('audio')
          else void beginRecording()
        }}
      />
    )
  }

  return (
    <div
      className={`chat${leaving ? ' chat--leaving' : ''}`}
      onClick={() => {
        if (menuMsgId) setMenuMsgId(null)
        if (callMenuOpen) setCallMenuOpen(false)
      }}
    >
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
              : outgoingPingLabel
                ? outgoingPingLabel
                : online
                  ? canEncrypt
                    ? 'Present'
                    : 'Establishing session…'
                  : 'Unavailable'}
          </p>
        </div>
        {canPing && onPingPeer && unavailable && (
          <button
            type="button"
            className="ghost-btn call-launch-btn"
            aria-label="Ping to come online"
            title="Ping"
            onClick={() => setPingConfirm(true)}
          >
            <PingIcon />
          </button>
        )}
        {onStartCall && online && canEncrypt && !unavailable && (
          <div className="call-launch" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="ghost-btn call-launch-btn"
              aria-label="Voice call. Hold or right-click for video options"
              aria-haspopup="menu"
              aria-expanded={callMenuOpen}
              onPointerDown={(e) => {
                // Left-click / touch only — right-click uses context menu.
                if (e.button !== 0) return
                callHoldFired.current = false
                if (callHoldTimer.current) {
                  window.clearTimeout(callHoldTimer.current)
                }
                callHoldTimer.current = window.setTimeout(() => {
                  callHoldFired.current = true
                  setCallMenuOpen(true)
                }, 420)
              }}
              onPointerUp={(e) => {
                if (e.button !== 0) return
                if (callHoldTimer.current) {
                  window.clearTimeout(callHoldTimer.current)
                  callHoldTimer.current = undefined
                }
                if (!callHoldFired.current && !callMenuOpen) {
                  void beginVoiceCall()
                }
              }}
              onPointerLeave={() => {
                if (callHoldTimer.current) {
                  window.clearTimeout(callHoldTimer.current)
                  callHoldTimer.current = undefined
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (callHoldTimer.current) {
                  window.clearTimeout(callHoldTimer.current)
                  callHoldTimer.current = undefined
                }
                callHoldFired.current = true
                setCallMenuOpen(true)
              }}
            >
              <PhoneIcon />
            </button>
            {callMenuOpen && (
              <div className="call-launch-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCallMenuOpen(false)
                    void beginVoiceCall()
                  }}
                >
                  Voice call
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCallMenuOpen(false)
                    void beginVideoCall()
                  }}
                >
                  Video call
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {showIncomingPing && onReceivePing && onIgnorePing && (
        <div className="ping-banner" role="status">
          <p>
            <strong>{peer.display_name}</strong> pinged you
          </p>
          <div className="ping-banner-actions">
            <button type="button" className="ping-btn ping-btn--receive" onClick={onReceivePing}>
              Receive
            </button>
            <button type="button" className="ping-btn ping-btn--ignore" onClick={onIgnorePing}>
              Ignore
            </button>
          </div>
        </div>
      )}

      {pingConfirm && onPingPeer && (
        <div className="ping-confirm" role="dialog" aria-modal="true">
          <div className="ping-confirm-card">
            <p>
              Ping <strong>{peer.display_name}</strong>? They&apos;ll get one
              notification. You can&apos;t ping them again until this expires
              (while you&apos;re online, then 15 min after you go offline).
            </p>
            <div className="ping-banner-actions">
              <button
                type="button"
                className="ping-btn ping-btn--receive"
                onClick={() => {
                  setPingConfirm(false)
                  onPingPeer()
                }}
              >
                Send ping
              </button>
              <button
                type="button"
                className="ping-btn ping-btn--ignore"
                onClick={() => setPingConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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
              const isFile = m.kind === 'file'
              const isSticker = m.kind === 'sticker'
              const menuOpen = menuMsgId === m.id
              return (
                <li
                  key={m.id}
                  className={`msg${mine ? ' msg--mine' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (isSnap) {
                      openSnap(m)
                      return
                    }
                  }}
                  onContextMenu={(e) => {
                    if (isSnap) return
                    e.preventDefault()
                    e.stopPropagation()
                    openMsgMenu(m.id)
                  }}
                  onTouchStart={(e) => {
                    const t = e.touches[0]
                    if (!t) return
                    swipeRef.current = { id: m.id, x: t.clientX }
                    if (isSnap) return
                    longPressTimer.current = window.setTimeout(() => {
                      openMsgMenu(m.id)
                    }, 400)
                  }}
                  onTouchMove={() => {
                    if (longPressTimer.current) {
                      window.clearTimeout(longPressTimer.current)
                      longPressTimer.current = undefined
                    }
                  }}
                  onTouchEnd={(e) => {
                    if (longPressTimer.current) {
                      window.clearTimeout(longPressTimer.current)
                      longPressTimer.current = undefined
                    }
                    const start = swipeRef.current
                    swipeRef.current = null
                    const t = e.changedTouches[0]
                    if (!start || !t || start.id !== m.id || isSnap) return
                    if (t.clientX - start.x >= 56 && online && canEncrypt) {
                      startReply(m)
                    }
                  }}
                >
                  <div
                    className={`msg-bubble${isSnap ? ' msg-bubble--snap' : ''}${isVoice ? ' msg-bubble--voice' : ''}${isSticker ? ' msg-bubble--sticker' : ''}`}
                  >
                    {m.reply_to && (
                      <div className="msg-reply-quote">
                        <span className="msg-reply-from">
                          {m.reply_to.from === me.id
                            ? 'You'
                            : peer.display_name}
                        </span>
                        <span>{m.reply_to.preview}</span>
                      </div>
                    )}
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
                    ) : isSticker && m.image_b64 ? (
                      <img
                        className="sticker-bubble-img"
                        src={`data:${m.sticker_mime || 'image/jpeg'};base64,${m.image_b64}`}
                        alt="Sticker"
                        draggable={false}
                      />
                    ) : isFile && m.file_b64 ? (
                      <a
                        className="nearby-file-link"
                        href={`data:${m.file_mime || 'application/octet-stream'};base64,${m.file_b64}`}
                        download={m.file_name || 'file'}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {m.file_name || 'File'}
                        {m.file_size != null
                          ? ` (${Math.round(m.file_size / 1024)} KB)`
                          : ''}
                      </a>
                    ) : (
                      <p>{m.text}</p>
                    )}
                    {mine && m.status !== 'sent' && m.status !== 'sending' && (
                      <span className="msg-status">{m.status}</span>
                    )}
                    {!isSnap && Object.keys(m.reactions).length > 0 && (
                      <div className="msg-reactions">
                        {Object.values(m.reactions).map((emoji, i) => (
                          <span key={`${m.id}-r-${i}`}>{emoji}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {menuOpen && online && canEncrypt && !isSnap && (
                    <div
                      className="msg-context-menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="reaction-picker">
                        {reactions.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => {
                              onReact(m.id, emoji)
                              setMenuMsgId(null)
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
                            setMenuMsgId(null)
                            setReactMore(false)
                          }}
                          onClose={() => setReactMore(false)}
                        />
                      )}
                      <button
                        type="button"
                        className="msg-context-reply"
                        onClick={() => startReply(m)}
                      >
                        Reply
                      </button>
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
            aria-label="Cancel reply"
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
        onPickEmoji={insertEmoji}
        onSendSticker={onSendSticker}
        stickersEnabled={!!onSendSticker}
        stickersDisabled={unavailable || !canEncrypt}
      />

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
          {onSendFile && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) onSendFile(f)
                }}
              />
              <button
                type="button"
                className="composer-cam"
                aria-label="Attach file"
                disabled={unavailable || !canEncrypt}
                onClick={() => fileInputRef.current?.click()}
              >
                ＋
              </button>
            </>
          )}
          <input
            ref={textInputRef}
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
          <ComposerMediaButton
            open={mediaTray.open}
            disabled={unavailable || !canEncrypt}
            onClick={mediaTray.toggle}
          />
          <button type="submit" disabled={unavailable || !canEncrypt || !text.trim()}>
            Send
          </button>
        </form>
      )}
      {recError && <p className="composer-error">{recError}</p>}
      {fileTransfer && (
        <div className="composer composer--rec">
          <span className="rec-label">
            Sending {fileTransfer.name} (
            {Math.min(
              100,
              Math.round((fileTransfer.sent / Math.max(1, fileTransfer.total)) * 100),
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

function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6.5 3.75h3.1l1.2 4.2-1.9 1.1a12.5 12.5 0 0 0 5.95 5.95l1.1-1.9 4.2 1.2v3.1c0 .7-.55 1.25-1.25 1.25C10.7 18.65 5.35 13.3 5.35 6.5c0-.7.55-1.25 1.15-1.25z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Radar-style cue for “nudge someone online”. */
function PingIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path
        d="M7.5 7.5a6.4 6.4 0 0 1 9 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M5 5a10 10 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M16.5 16.5a6.4 6.4 0 0 1-9 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M19 19a10 10 0 0 1-14 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.55"
      />
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
