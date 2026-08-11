import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { hapticLight } from '../haptics'
import { formatDuration, voiceObjectUrl } from '../voiceAudio'
import { claimVoicePlayback, releaseVoicePlayback } from '../voicePlayback'

interface VoiceBubbleProps {
  audioB64: string
  mime: string
  durationMs: number
}

export function VoiceBubble({ audioB64, mime, durationMs }: VoiceBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [displayMs, setDisplayMs] = useState(durationMs)
  const [progress, setProgress] = useState(0)
  const stopSelfRef = useRef<() => void>(() => {})

  useEffect(() => {
    setDisplayMs(durationMs)
  }, [durationMs])

  useEffect(() => {
    stopSelfRef.current = () => {
      const a = audioRef.current
      if (a) {
        a.pause()
        a.currentTime = 0
      }
      setPlaying(false)
      setProgress(0)
      releaseVoicePlayback(stopSelfRef.current)
    }
  })

  useEffect(() => {
    return () => {
      stopSelfRef.current()
      const a = audioRef.current
      if (a) {
        a.pause()
        a.removeAttribute('src')
        a.load()
      }
      audioRef.current = null
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [])

  function ensureAudio(): HTMLAudioElement {
    if (audioRef.current) return audioRef.current
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    const url = voiceObjectUrl(mime, audioB64)
    urlRef.current = url
    const a = new Audio(url)
    a.preload = 'auto'
    a.ontimeupdate = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        setProgress(a.currentTime / a.duration)
      }
    }
    a.onended = () => {
      setPlaying(false)
      setProgress(0)
      releaseVoicePlayback(stopSelfRef.current)
    }
    a.onpause = () => {
      if (a.ended || a.currentTime === 0) setPlaying(false)
    }
    a.onplay = () => setPlaying(true)
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        setDisplayMs(Math.round(a.duration * 1000))
      }
      setLoading(false)
    }
    a.oncanplaythrough = () => setLoading(false)
    a.onerror = () => {
      setError(true)
      setPlaying(false)
      setLoading(false)
      releaseVoicePlayback(stopSelfRef.current)
    }
    audioRef.current = a
    return a
  }

  async function toggle(e: MouseEvent) {
    e.stopPropagation()
    setError(false)
    hapticLight()
    try {
      const a = ensureAudio()
      if (playing) {
        a.pause()
        setPlaying(false)
        releaseVoicePlayback(stopSelfRef.current)
        return
      }
      claimVoicePlayback(stopSelfRef.current)
      setLoading(true)
      if (a.ended) a.currentTime = 0
      // Prefetch: wait briefly for canplay if needed
      if (a.readyState < 3) {
        await new Promise<void>((resolve) => {
          const done = () => {
            a.removeEventListener('canplay', done)
            resolve()
          }
          a.addEventListener('canplay', done)
          window.setTimeout(done, 1500)
        })
      }
      await a.play()
      setPlaying(true)
      setLoading(false)
    } catch {
      setError(true)
      setPlaying(false)
      setLoading(false)
      releaseVoicePlayback(stopSelfRef.current)
    }
  }

  const bars = 12
  return (
    <div className={`voice-bubble${playing ? ' voice-bubble--playing' : ''}`}>
      <button
        type="button"
        className="voice-play"
        onClick={(e) => void toggle(e)}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {loading ? '…' : playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-meta">
        <div className="voice-wave" aria-hidden>
          {Array.from({ length: bars }, (_, i) => {
            const lit = playing && progress >= i / bars
            return (
              <span
                key={i}
                className={`voice-wave-bar${lit ? ' voice-wave-bar--on' : ''}`}
                style={{ height: `${30 + ((i * 17) % 70)}%` }}
              />
            )
          })}
        </div>
        <span className="voice-dur">
          {error ? 'Can’t play' : loading ? 'Loading…' : formatDuration(displayMs)}
        </span>
      </div>
    </div>
  )
}
