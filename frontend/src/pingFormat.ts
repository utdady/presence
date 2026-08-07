/** Format remaining offline-grace for an active ping. */
export function formatPingCountdown(expiresAt: number | null): string {
  if (expiresAt == null) return 'Pinged · online'
  const left = Math.max(0, Math.ceil(expiresAt - Date.now() / 1000))
  if (left <= 0) return 'Pinged · ending…'
  const m = Math.floor(left / 60)
  const s = left % 60
  if (m >= 1) return `Pinged · ${m}m left`
  return `Pinged · ${s}s left`
}
