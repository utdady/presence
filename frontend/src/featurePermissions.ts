/**
 * Contextual device-permission primes (industry pattern):
 * explain why → user continues → system prompt.
 * Shown once per feature per device unless already granted.
 */

export type FeatureKind = 'camera' | 'microphone' | 'nearby'

export type FeaturePrimeCopy = {
  title: string
  body: string
  allowLabel: string
  denyLabel: string
}

export const FEATURE_PRIME: Record<FeatureKind, FeaturePrimeCopy> = {
  camera: {
    title: 'Camera access',
    body: 'Presence uses the camera for snaps and video calls. Media is encrypted end-to-end and only lasts while both of you are online.',
    allowLabel: 'Allow camera',
    denyLabel: 'Not now',
  },
  microphone: {
    title: 'Microphone access',
    body: 'Presence uses the mic for voice notes and voice/video calls. Audio is encrypted and only lasts while both people are present.',
    allowLabel: 'Allow microphone',
    denyLabel: 'Not now',
  },
  nearby: {
    title: 'Nearby & Bluetooth',
    body: 'Offline Nearby talks over Bluetooth only—never Wi‑Fi or the internet. Allow Bluetooth when prompted. Older Android versions may also ask for Location only so the system can find nearby phones (Presence does not track your GPS). Used only while Nearby is open.',
    allowLabel: 'Continue',
    denyLabel: 'Not now',
  },
}

function primeKey(kind: FeatureKind): string {
  return `presence_perm_prime_${kind}`
}

export function isPrimeSeen(kind: FeatureKind): boolean {
  try {
    return localStorage.getItem(primeKey(kind)) === '1'
  } catch {
    return false
  }
}

export function markPrimeSeen(kind: FeatureKind): void {
  try {
    localStorage.setItem(primeKey(kind), '1')
  } catch {
    /* ignore quota / private mode */
  }
}

/** Best-effort Permissions API check; 'unknown' if unsupported or failed. */
export async function mediaPermissionState(
  name: 'camera' | 'microphone',
): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    if (!navigator.permissions?.query) return 'unknown'
    const status = await navigator.permissions.query({
      name: name as PermissionName,
    })
    if (status.state === 'granted') return 'granted'
    if (status.state === 'denied') return 'denied'
    return 'prompt'
  } catch {
    return 'unknown'
  }
}

/**
 * Whether to show our in-app prime before the system dialog.
 * Skip if user already saw it, or the browser already granted access.
 */
export async function shouldShowPrime(kind: FeatureKind): Promise<boolean> {
  if (isPrimeSeen(kind)) return false
  if (kind === 'camera' || kind === 'microphone') {
    const state = await mediaPermissionState(kind)
    if (state === 'granted') {
      markPrimeSeen(kind)
      return false
    }
  }
  return true
}
