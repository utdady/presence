const CREDS_KEY = 'presence_remembered_creds'

export interface RememberedCreds {
  username: string
  password: string
}

export function getRememberedCreds(): RememberedCreds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedCreds>
    if (
      typeof parsed.username !== 'string' ||
      typeof parsed.password !== 'string' ||
      !parsed.username
    ) {
      return null
    }
    return { username: parsed.username, password: parsed.password }
  } catch {
    return null
  }
}

export function setRememberedCreds(creds: RememberedCreds): void {
  localStorage.setItem(
    CREDS_KEY,
    JSON.stringify({
      username: creds.username.trim(),
      password: creds.password,
    }),
  )
}

export function clearRememberedCreds(): void {
  localStorage.removeItem(CREDS_KEY)
}
