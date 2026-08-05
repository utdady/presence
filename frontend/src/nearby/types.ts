export type NearbyCallPhase =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'ready'
  | 'outgoing'
  | 'incoming'
  | 'in_call'
  | 'ended'

export interface NearbyPeerInfo {
  id: string
  name: string
}

export interface NearbyHello {
  type: 'hello'
  userId: string
  displayName: string
  publicKey: string
}

export type NearbyPlainSignal =
  | { type: 'call-offer'; fromName: string; fingerprint: string }
  | { type: 'call-answer' }
  | { type: 'call-reject' }
  | { type: 'call-end' }
  /** Legacy LAN/WebRTC path only — ignored on Bluetooth native. */
  | { type: 'webrtc-signal'; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }
  | {
      type: 'chat'
      id: string
      text: string
      fromName: string
      sentAt: number
      reply_to?: {
        msg_id: string
        preview: string
        from: string
      }
    }
  | {
      type: 'reaction'
      msg_id: string
      emoji: string
      fromName: string
    }
  | {
      type: 'sticker'
      id: string
      mime: string
      dataB64: string
      fromName: string
      sentAt: number
    }
  | {
      type: 'voice-chunk'
      id: string
      seq: number
      mime: string
      dataB64: string
    }
  | {
      type: 'voice-note'
      id: string
      mime: string
      dataB64: string
      durationMs: number
      fromName: string
      sentAt: number
    }
  | {
      type: 'file-meta'
      id: string
      name: string
      mime: string
      size: number
      totalChunks: number
      fromName: string
      sentAt: number
    }
  | {
      type: 'file-chunk'
      id: string
      index: number
      dataB64: string
    }
  | {
      type: 'file-end'
      id: string
    }
  | {
      type: 'file-cancel'
      id: string
    }

export interface NearbyChatMessage {
  id: string
  text: string
  fromName: string
  sentAt: number
  mine: boolean
  kind?: 'text' | 'voice' | 'file' | 'sticker'
  audio_b64?: string
  audio_mime?: string
  duration_ms?: number
  file_name?: string
  file_mime?: string
  file_b64?: string
  file_size?: number
  image_b64?: string
  sticker_mime?: string
  reply_to?: {
    msg_id: string
    preview: string
    from: string
  }
  reactions?: Record<string, string>
}

export type NearbyWire =
  | NearbyHello
  | { type: 'enc'; payload: string }

/** Map noisy native BT errors to short user copy. */
export function friendlyNearbyError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('permission')) {
    return 'Bluetooth permission needed. Enable it in system Settings.'
  }
  if (m.includes('8012') || m.includes('endpoint_io') || m.includes('io error')) {
    return 'Connection dropped. Stay closer and try again — only one side taps Connect.'
  }
  if (m.includes('8007') || m.includes('bluetooth_error')) {
    return 'Bluetooth glitch. Toggle Bluetooth off/on, then Find nearby again.'
  }
  if (m.includes('already') && m.includes('advertis')) {
    return 'Still starting Bluetooth… try Stop, then Find nearby.'
  }
  if (m.includes('connect failed') || m.includes('rfcomm')) {
    return 'Could not connect. Keep both on Find nearby; connect from the device that sees the other.'
  }
  if (raw.length > 120) return `${raw.slice(0, 117)}…`
  return raw
}
