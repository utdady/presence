import { Capacitor } from '@capacitor/core'
import { APP_PRODUCT } from './appVersion'

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

function isTauriShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

function titleFor(onlineCount: number): string {
  return onlineCount > 0
    ? `(${onlineCount}) ${APP_PRODUCT}`
    : APP_PRODUCT
}

/**
 * Show how many friends are currently online (session live only).
 * Clears on 0 / disconnect. Best-effort across web / Android / desktop.
 */
export async function setOnlineFriendBadge(onlineCount: number): Promise<void> {
  const n = Math.max(0, Math.floor(onlineCount))
  const title = titleFor(n)

  try {
    if (typeof document !== 'undefined') {
      document.title = title
    }
  } catch {
    /* ignore */
  }

  // Web / installed PWA Badging API
  try {
    const nav = navigator as BadgeNavigator
    if (typeof nav.setAppBadge === 'function') {
      if (n > 0) await nav.setAppBadge(n)
      else if (typeof nav.clearAppBadge === 'function') await nav.clearAppBadge()
    }
  } catch {
    /* unsupported or blocked */
  }

  // Android native launcher badge (via nearby plugin)
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const { PresenceNearby } = await import('presence-nearby')
      await PresenceNearby.setAppBadge({ count: n })
    } catch {
      /* old APK without method */
    }
  }

  // Tauri desktop window title
  if (isTauriShell()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setTitle(title)
    } catch {
      /* ignore */
    }
  }
}

export async function clearOnlineFriendBadge(): Promise<void> {
  await setOnlineFriendBadge(0)
}
