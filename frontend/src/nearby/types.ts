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
  | { type: 'chat'; id: string; text: string; fromName: string; sentAt: number }
  | {
      type: 'voice-chunk'
      id: string
      seq: number
      mime: string
      dataB64: string
    }

export interface NearbyChatMessage {
  id: string
  text: string
  fromName: string
  sentAt: number
  mine: boolean
}

export type NearbyWire =
  | NearbyHello
  | { type: 'enc'; payload: string }
