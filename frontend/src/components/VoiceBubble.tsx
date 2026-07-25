import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { formatDuration, voiceObjectUrl } from '../voiceAudio'

interface VoiceBubbleProps {
  audioB64: string
  mime: string
  durationMs: number
}

export function VoiceBubble({ audioB64, mime, durationMs }: VoiceBubbleProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const [displayMs, setDisplayMs] = useState(durationMs)

  useEffect(() => {
    setDisplayMs(durationMs)
  }, [durationMs])

  useEffect(() => {
    return () => {
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
    a.onended = () => setPlaying(false)
    a.onpause = () => setPlaying(false)
    a.onplay = () => setPlaying(true)
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        setDisplayMs(Math.round(a.duration * 1000))
      }
    }
    a.onerror = () => {
      setError(true)
      setPlaying(false)
    }
    audioRef.current = a
    return a
  }

  async function toggle(e: MouseEvent) {
    e.stopPropagation()
    setError(false)
    try {
      const a = ensureAudio()
      if (playing) {
        a.pause()
        setPlaying(false)
        return
      }
      // Restart from beginning if ended
      if (a.ended) a.currentTime = 0
      await a.play()
      setPlaying(true)
    } catch {
      setError(true)
      setPlaying(false)
    }
  }

  return (
    <div className="voice-bubble">
      <button
        type="button"
        className="voice-play"
        onClick={(e) => void toggle(e)}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-meta">
        <span className="voice-label">Voice</span>
        <span className="voice-dur">
          {error ? 'Can’t play' : formatDuration(displayMs)}
        </span>
      </div>
    </div>
  )
}
