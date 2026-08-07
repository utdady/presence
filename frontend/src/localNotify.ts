/**
 * Best-effort system notifications for pings (web + WebView when allowed).
 * Not FCM — works while the app process can show them or on next connect.
 */

export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    const r = await Notification.requestPermission()
    return r === 'granted'
  } catch {
    return false
  }
}

export async function showLocalNotify(
  title: string,
  body?: string,
): Promise<void> {
  try {
    if (!(await ensureNotifyPermission())) return
    const n = new Notification(title, {
      body: body ?? '',
      silent: false,
      tag: `presence-ping-${title.slice(0, 24)}`,
    })
    window.setTimeout(() => n.close(), 12_000)
  } catch {
    /* ignore */
  }
}
