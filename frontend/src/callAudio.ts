import { Capacitor } from '@capacitor/core'
import { PresenceNearby } from 'presence-nearby'

type SinkAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>
}

export function canToggleSpeaker(): boolean {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    return true
  }
  return typeof (HTMLMediaElement.prototype as SinkAudio).setSinkId === 'function'
}

/**
 * After a native AudioManager route flip, WebRTC's AEC can lose its render
 * reference. Briefly bounce live audio tracks so it reacquires — skip tracks
 * the user already muted.
 */
async function reacquireAec(localStream?: MediaStream | null): Promise<void> {
  if (!localStream) return
  const tracks = localStream
    .getAudioTracks()
    .filter((t) => t.readyState === 'live' && t.enabled)
  if (tracks.length === 0) return
  for (const t of tracks) t.enabled = false
  await new Promise((r) => window.setTimeout(r, 50))
  for (const t of tracks) {
    if (t.readyState === 'live') t.enabled = true
  }
}

/** Loudspeaker vs earpiece / default output. */
export async function applySpeakerRoute(
  audio: HTMLAudioElement | null,
  speakerOn: boolean,
  localStream?: MediaStream | null,
): Promise<void> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await PresenceNearby.setSpeakerphone({ on: speakerOn })
    } catch {
      /* plugin missing on old APK */
    }
    // Earpiece path may reassert natively ~80ms later — wait, then bounce AEC.
    await new Promise((r) => window.setTimeout(r, speakerOn ? 40 : 120))
    await reacquireAec(localStream)
    return
  }

  const el = audio as SinkAudio | null
  if (!el?.setSinkId) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter((d) => d.kind === 'audiooutput')
    let sinkId = ''
    if (speakerOn) {
      const sp = outputs.find((d) => /speaker|loud/i.test(d.label))
      sinkId = sp?.deviceId ?? outputs[0]?.deviceId ?? ''
    } else {
      const ear = outputs.find((d) =>
        /earpiece|receiver|handset|phone/i.test(d.label),
      )
      sinkId = ear?.deviceId ?? ''
    }
    await el.setSinkId(sinkId)
  } catch {
    /* ignore unsupported sink */
  }
}

export async function resetSpeakerRoute(): Promise<void> {
  await applySpeakerRoute(null, false)
}
