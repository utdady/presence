const CREDS_KEY = 'presence_remembered_creds'

// Username only — passwords are never persisted on-device. The JWT keeps the
// session alive; leaking the password would also leak the E2E identity key.
export interface RememberedCreds {
  username: string
}

export function getRememberedCreds(): RememberedCreds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedCreds> & {
      password?: unknown
    }
    if (typeof parsed.username !== 'string' || !parsed.username) {
      return null
    }
    // Migration: rewrite legacy entries that still carry a plaintext password.
    if ('password' in parsed) {
      setRememberedCreds({ username: parsed.username })
    }
    return { username: parsed.username }
  } catch {
    return null
  }
}

export function setRememberedCreds(creds: RememberedCreds): void {
  localStorage.setItem(
    CREDS_KEY,
    JSON.stringify({ username: creds.username.trim() }),
  )
}

export function clearRememberedCreds(): void {
  localStorage.removeItem(CREDS_KEY)
}
