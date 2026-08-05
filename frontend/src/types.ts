export type Role = 'hub' | 'spoke'

export type SnapTimerSec = 0 | 1 | 3 | 5 | 10

export type VoiceMime = 'audio/webm' | 'audio/mp4' | 'audio/ogg' | 'audio/webm;codecs=opus'

export interface UserPublic {
  id: string
  username: string
  display_name: string
  role: Role
  avatar_color: string
  online: boolean
}

export interface AuthResponse {
  access_token: string
  token_type: string
  user: UserPublic
}

export type WsIncoming =
  | {
      type: 'presence'
      from: string
      user: UserPublic
    }
  | {
      type: 'pubkey'
      from: string
      to: string
      payload: string
    }
  | {
      type:
        | 'msg'
        | 'typing'
        | 'reaction'
        | 'snap'
        | 'voice'
        | 'profile'
        | 'call'
        | 'file'
      from: string
      to: string
      payload: string
      msg_id?: string
    }
  | {
      type: 'ack'
      to: string
      msg_id?: string
      payload: 'ok' | 'undelivered' | 'forbidden'
    }
  | {
      type: 'peer_offline'
      from: string
      to: string
    }
  | {
      type: 'error'
      payload: string
    }

export interface MessageReplyTo {
  msg_id: string
  preview: string
  from: string
}

export interface ChatMessage {
  id: string
  from: string
  /** Present for text messages; snaps/voice use kind instead */
  text: string
  status: 'sending' | 'sent' | 'undelivered' | 'failed'
  reactions: Record<string, string>
  kind?: 'text' | 'snap' | 'voice' | 'file' | 'sticker'
  timer_sec?: SnapTimerSec
  opened?: boolean
  /** Raw JPEG base64 (no data: prefix). Cleared after view-once consume. */
  image_b64?: string
  /** Raw audio base64. Kept while both online. */
  audio_b64?: string
  audio_mime?: string
  duration_ms?: number
  file_name?: string
  file_mime?: string
  file_b64?: string
  file_size?: number
  reply_to?: MessageReplyTo
  sticker_mime?: string
}

export type PlainPayload =
  | {
      kind: 'msg'
      text: string
      msg_id: string
      reply_to?: MessageReplyTo
    }
  | { kind: 'typing'; active: boolean }
  | { kind: 'reaction'; msg_id: string; emoji: string }
  | {
      kind: 'sticker'
      msg_id: string
      mime: string
      image_b64: string
    }
  | {
      kind: 'snap'
      msg_id: string
      mime: 'image/jpeg'
      image_b64: string
      timer_sec: SnapTimerSec
    }
  | {
      kind: 'voice'
      msg_id: string
      mime: string
      audio_b64: string
      duration_ms: number
    }
  | {
      kind: 'profile'
      version: string
      mime: 'image/jpeg'
      image_b64: string
    }
  | {
      kind: 'profile'
      version: string
      clear: true
    }
  | { kind: 'call-offer'; fingerprint: string; media?: 'audio' | 'video' }
  | { kind: 'call-answer' }
  | { kind: 'call-reject' }
  | { kind: 'call-end' }
  | {
      kind: 'webrtc-signal'
      signal: RTCSessionDescriptionInit | RTCIceCandidateInit
    }
  | {
      kind: 'file-meta'
      msg_id: string
      name: string
      mime: string
      size: number
      totalChunks: number
    }
  | {
      kind: 'file-chunk'
      msg_id: string
      index: number
      data_b64: string
    }
  | {
      kind: 'file-end'
      msg_id: string
    }
  | {
      kind: 'file-cancel'
      msg_id: string
    }

export interface InvitePublic {
  code: string
  label: string
  max_uses: number
  uses: number
  created_at: string
  revoked: boolean
  invite_path: string
}

export interface MemberPrivate {
  id: string
  username: string
  display_name: string
  role: Role
  avatar_color: string
  online: boolean
  password: string | null
}
