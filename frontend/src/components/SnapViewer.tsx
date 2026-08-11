import { useEffect, useRef, useState } from 'react'
import { hapticLight } from '../haptics'
import { snapDataUrl } from '../snapImage'
import type { SnapTimerSec } from '../types'

interface SnapViewerProps {
  imageB64: string
  timerSec: SnapTimerSec
  peerName: string
  onClose: () => void
}

export function SnapViewer({
  imageB64,
  timerSec,
  peerName,
  onClose,
}: SnapViewerProps) {
  const [remaining, setRemaining] = useState(timerSec as number)
  const closedRef = useRef(false)

  function finish() {
    if (closedRef.current) return
    closedRef.current = true
    hapticLight()
    onClose()
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (timerSec <= 0) return
    setRemaining(timerSec)
    const started = Date.now()
    const id = window.setInterval(() => {
      const left = Math.max(
        0,
        timerSec - Math.floor((Date.now() - started) / 1000),
      )
      setRemaining(left)
      if (left <= 0) {
        window.clearInterval(id)
        finish()
      }
    }, 200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerSec, imageB64])

  return (
    <div
      className="snap-viewer"
      role="dialog"
      aria-label={`Snap from ${peerName}`}
      onClick={finish}
    >
      <header className="snap-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="ghost-btn" onClick={finish}>
          Close
        </button>
        <span className="snap-viewer-meta">
          {timerSec > 0 ? `${remaining}s` : 'View once'}
        </span>
      </header>
      <img
        className="snap-viewer-img"
        src={snapDataUrl(imageB64)}
        alt=""
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      <p className="snap-viewer-hint">Tap outside or Close to discard</p>
    </div>
  )
}
