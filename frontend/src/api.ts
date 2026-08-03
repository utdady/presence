import { Capacitor } from '@capacitor/core'

/** Production origin — used for absolute API calls inside the Android WebView. */
export const PROD_ORIGIN = 'https://presence-addy.fly.dev'

/**
 * Relative paths work in the browser (Vite proxy / same origin on Fly).
 * On native, always hit production so login/API never depend on WebView origin quirks.
 */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  if (Capacitor.isNativePlatform()) {
    return `${PROD_ORIGIN}${p}`
  }
  return p
}

export function formatApiDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'msg' in item) {
          const msg = String((item as { msg: unknown }).msg)
          if (/json decode/i.test(msg)) {
            return 'Could not reach the server. Check your connection and try again.'
          }
          return msg
        }
        return null
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  return fallback
}

async function readError(res: Response, fallback: string): Promise<string> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { detail?: unknown }
    return formatApiDetail(body.detail, fallback)
  } catch {
    if (text.trim().startsWith('<')) {
      return 'Server returned a web page instead of data. Try again or update the app.'
    }
    return fallback
  }
}

const TOKEN_KEY = 'presence_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export async function login(
  username: string,
  password: string,
): Promise<import('./types').AuthResponse> {
  const res = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    throw new Error(await readError(res, 'Login failed'))
  }
  return res.json()
}

export async function fetchMe(
  token: string,
): Promise<import('./types').UserPublic> {
  const res = await fetch(apiUrl('/me'), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Session expired')
  return res.json()
}

export async function fetchPeers(
  token: string,
): Promise<import('./types').UserPublic[]> {
  const res = await fetch(apiUrl('/peers'), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Failed to load peers')
  return res.json()
}

export function wsUrl(token: string): string {
  if (Capacitor.isNativePlatform()) {
    const u = new URL(PROD_ORIGIN)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}/ws?token=${encodeURIComponent(token)}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
}

export async function signup(input: {
  invite_code: string
  username: string
  display_name: string
  password: string
}): Promise<import('./types').AuthResponse> {
  const res = await fetch(apiUrl('/auth/signup'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await readError(res, 'Signup failed'))
  }
  return res.json()
}

export async function fetchInvites(
  token: string,
): Promise<import('./types').InvitePublic[]> {
  const res = await fetch(apiUrl('/invites'), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Failed to load invites')
  return res.json()
}

export async function createInvite(
  token: string,
  input: { label?: string; max_uses?: number } = {},
): Promise<import('./types').InvitePublic> {
  const res = await fetch(apiUrl('/invites'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await readError(res, 'Could not create invite'))
  }
  return res.json()
}

export async function revokeInvite(
  token: string,
  code: string,
): Promise<import('./types').InvitePublic> {
  const res = await fetch(apiUrl(`/invites/${encodeURIComponent(code)}/revoke`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Could not revoke invite')
  return res.json()
}

export async function fetchMembers(
  token: string,
): Promise<import('./types').MemberPrivate[]> {
  const res = await fetch(apiUrl('/members'), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Failed to load members')
  return res.json()
}
