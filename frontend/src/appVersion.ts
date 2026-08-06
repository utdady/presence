/**
 * Product versioning (pre-1.0 Beta).
 *
 * Android:
 *   versionCode = integer N (must always increase; used for update checks)
 *   versionName = "0.N"   (what users see)
 *
 * Desktop / web use APP_SEMVER. At 1.0, switch marketing/channel without
 * lowering versionCode.
 */

/** Always "beta" until a production 1.0 cut. */
export const APP_CHANNEL = 'beta' as const

/**
 * Last-known product revision (align with latest APK versionCode when shipping).
 * Used for web + desktop labels when native build info is unavailable.
 */
export const APP_VERSION_CODE = 16

/** Short marketing form: 0.16 */
export function marketingVersion(code: number = APP_VERSION_CODE): string {
  return `0.${code}`
}

/** Semver for package managers / Tauri (patch for hotfixes). */
export const APP_SEMVER = `${marketingVersion()}.0`

export function formatVersionLabel(code?: number): string {
  return `${marketingVersion(code ?? APP_VERSION_CODE)} · Beta`
}

export function formatAppTitle(code?: number): string {
  return `Presence ${formatVersionLabel(code)}`
}

/** Shorter product name. */
export const APP_PRODUCT = 'Presence Beta'
