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
      type: 'msg' | 'typing' | 'reaction' | 'snap' | 'voice' | 'profile'
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

export interface ChatMessage {
  id: string
  from: string
  /** Present for text messages; snaps/voice use kind instead */
  text: string
  status: 'sending' | 'sent' | 'undelivered' | 'failed'
  reactions: Record<string, string>
  kind?: 'text' | 'snap' | 'voice'
  timer_sec?: SnapTimerSec
  opened?: boolean
  /** Raw JPEG base64 (no data: prefix). Cleared after view-once consume. */
  image_b64?: string
  /** Raw audio base64. Kept while both online. */
  audio_b64?: string
  audio_mime?: string
  duration_ms?: number
}

export type PlainPayload =
  | { kind: 'msg'; text: string; msg_id: string }
  | { kind: 'typing'; active: boolean }
  | { kind: 'reaction'; msg_id: string; emoji: string }
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
