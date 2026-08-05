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

/** Loudspeaker vs earpiece / default output. */
export async function applySpeakerRoute(
  audio: HTMLAudioElement | null,
  speakerOn: boolean,
): Promise<void> {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      await PresenceNearby.setSpeakerphone({ on: speakerOn })
    } catch {
      /* plugin missing on old APK */
    }
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
