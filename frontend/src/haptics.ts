import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

function canHaptic(): boolean {
  return Capacitor.isNativePlatform()
}

/** Light tap — toggles, selections, soft confirms. */
export function hapticLight(): void {
  if (!canHaptic()) return
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
}

/** Medium tap — primary actions (send, accept, capture). */
export function hapticMedium(): void {
  if (!canHaptic()) return
  void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
}

/** Heavy tap — destructive / end-call. */
export function hapticHeavy(): void {
  if (!canHaptic()) return
  void Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {})
}

/** Selection tick — picker rows, theme switch. */
export function hapticSelection(): void {
  if (!canHaptic()) return
  void Haptics.selectionStart().catch(() => {})
  void Haptics.selectionChanged().catch(() => {})
  void Haptics.selectionEnd().catch(() => {})
}

/** Success pattern — call connected, invite created. */
export function hapticSuccess(): void {
  if (!canHaptic()) return
  void Haptics.notification({ type: NotificationType.Success }).catch(() => {})
}

/** Warning pattern — poor connection, key mismatch. */
export function hapticWarning(): void {
  if (!canHaptic()) return
  void Haptics.notification({ type: NotificationType.Warning }).catch(() => {})
}

/** Error pattern — reject / failed action. */
export function hapticError(): void {
  if (!canHaptic()) return
  void Haptics.notification({ type: NotificationType.Error }).catch(() => {})
}
