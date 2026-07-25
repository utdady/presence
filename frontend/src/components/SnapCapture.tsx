import { useCallback, useEffect, useRef, useState } from 'react'
import { videoFrameToSnapJpeg } from '../snapImage'
import type { SnapTimerSec } from '../types'

const TIMERS: { label: string; value: SnapTimerSec }[] = [
  { label: 'Off', value: 0 },
  { label: '1s', value: 1 },
  { label: '3s', value: 3 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
]

interface SnapCaptureProps {
  onSend: (imageB64: string, timerSec: SnapTimerSec) => void
  onClose: () => void
}

export function SnapCapture({ onSend, onClose }: SnapCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const genRef = useRef(0)
  const aliveRef = useRef(true)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [timerSec, setTimerSec] = useState<SnapTimerSec>(0)
  const [frozenB64, setFrozenB64] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const stopStream = useCallback(() => {
    // Invalidate in-flight getUserMedia so a late resolve won't reattach
    genRef.current += 1
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const video = videoRef.current
    if (video) {
      video.srcObject = null
    }
  }, [])

  const startCamera = useCallback(async () => {
    setError(null)
    stopStream()
    const gen = genRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      // Cancelled, flipped, or unmounted while permission/dialog was open
      if (!aliveRef.current || gen !== genRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play()
      }
    } catch {
      if (aliveRef.current && gen === genRef.current) {
        setError('Camera access denied or unavailable')
      }
    }
  }, [facing, stopStream])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      stopStream()
    }
  }, [stopStream])

  useEffect(() => {
    if (frozenB64) return
    void startCamera()
    return () => stopStream()
  }, [startCamera, stopStream, frozenB64])

  async function handleShutter() {
    const video = videoRef.current
    if (!video || busy) return
    setBusy(true)
    setError(null)
    try {
      const b64 = await videoFrameToSnapJpeg(video)
      stopStream()
      setFrozenB64(b64)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capture failed')
    } finally {
      setBusy(false)
    }
  }

  function handleRetake() {
    setFrozenB64(null)
  }

  function handleSend() {
    if (!frozenB64) return
    stopStream()
    onSend(frozenB64, timerSec)
  }

  function handleCancel() {
    stopStream()
    onClose()
  }

  return (
    <div className="snap-capture" role="dialog" aria-label="Take a snap">
      <header className="snap-capture-bar">
        <button type="button" className="ghost-btn" onClick={handleCancel}>
          Cancel
        </button>
        <span className="snap-capture-title">Snap</span>
        <button
          type="button"
          className="ghost-btn"
          onClick={() =>
            setFacing((f) => (f === 'user' ? 'environment' : 'user'))
          }
          disabled={!!frozenB64}
          aria-label="Flip camera"
        >
          Flip
        </button>
      </header>

      <div className="snap-capture-stage">
        {frozenB64 ? (
          <img
            className="snap-capture-preview"
            src={`data:image/jpeg;base64,${frozenB64}`}
            alt="Captured snap"
          />
        ) : (
          <video
            ref={videoRef}
            className="snap-capture-preview"
            playsInline
            muted
            autoPlay
          />
        )}
      </div>

      <div className="snap-timer-row" role="group" aria-label="View timer">
        {TIMERS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={`snap-timer-chip${timerSec === t.value ? ' snap-timer-chip--on' : ''}`}
            onClick={() => setTimerSec(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="snap-capture-error">{error}</p>}

      <div className="snap-capture-actions">
        {frozenB64 ? (
          <>
            <button type="button" className="ghost-btn" onClick={handleRetake}>
              Retake
            </button>
            <button type="button" className="snap-send-btn" onClick={handleSend}>
              Send
            </button>
          </>
        ) : (
          <button
            type="button"
            className="snap-shutter"
            onClick={() => void handleShutter()}
            disabled={busy || !!error}
            aria-label="Shutter"
          />
        )}
      </div>
    </div>
  )
}
