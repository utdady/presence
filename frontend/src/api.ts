import type { AuthResponse, InvitePublic, UserPublic } from './types'

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

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? 'Login failed')
  }
  return res.json()
}

export async function fetchMe(token: string): Promise<UserPublic> {
  const res = await fetch('/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Session expired')
  return res.json()
}

export async function fetchPeers(token: string): Promise<UserPublic[]> {
  const res = await fetch('/peers', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to load peers')
  return res.json()
}

export function wsUrl(token: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
}

export async function signup(input: {
  invite_code: string
  username: string
  display_name: string
  password: string
}): Promise<AuthResponse> {
  const res = await fetch('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = body.detail
    throw new Error(
      typeof detail === 'string' ? detail : 'Signup failed',
    )
  }
  return res.json()
}

export async function fetchInvites(token: string): Promise<InvitePublic[]> {
  const res = await fetch('/invites', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to load invites')
  return res.json()
}

export async function createInvite(
  token: string,
  input: { label?: string; max_uses?: number } = {},
): Promise<InvitePublic> {
  const res = await fetch('/invites', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? 'Could not create invite')
  }
  return res.json()
}

export async function revokeInvite(token: string, code: string): Promise<InvitePublic> {
  const res = await fetch(`/invites/${encodeURIComponent(code)}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Could not revoke invite')
  return res.json()
}
