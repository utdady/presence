/**
 * Product versioning (pre-1.0 Beta).
 *
 * Android:
 *   versionCode = integer N (must always increase; used for update checks)
 *   versionName = "0.N"   (what users see)
 *
 * Desktop / web use APP_SEMVER. At 1.0, switch marketing/channel without
 * lowering versionCode.
 *
 * On native Android, prefer App.getInfo() build so the settings line tracks
 * the installed APK rather than this source default.
 */

/** Always "beta" until a production 1.0 cut. */
export const APP_CHANNEL = 'beta' as const

/**
 * Fallback product revision when native build info is unavailable (web / desktop).
 * Align with latest shipped APK versionCode when you cut a release.
 */
export const APP_VERSION_CODE = 20

/** Short marketing form: 0.16 */
export function marketingVersion(code: number = APP_VERSION_CODE): string {
  return `0.${code}`
}

/** Semver for package managers / Tauri (patch for hotfixes). */
export const APP_SEMVER = `${marketingVersion()}.0`

/** Version number only (e.g. "0.16"). Avoids double “Beta” when combined with APP_PRODUCT. */
export function formatVersionLabel(code?: number): string {
  return marketingVersion(code ?? APP_VERSION_CODE)
}

/** Single user-facing line: "Presence Beta · 0.16" */
export function formatProductVersion(code?: number): string {
  return `Presence Beta · ${formatVersionLabel(code)}`
}

export function formatAppTitle(code?: number): string {
  return formatProductVersion(code)
}

/** Product name only (settings / badges). */
export const APP_PRODUCT = 'Presence Beta'

/**
 * Prefer the installed native versionCode when available so settings match the APK.
 */
export async function resolveInstalledVersionCode(): Promise<number> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { App } = await import('@capacitor/app')
      const info = await App.getInfo()
      const build = Number.parseInt(info.build, 10)
      if (Number.isFinite(build) && build > 0) return build
      const fromName = info.version?.match(/^0\.(\d+)/i)
      if (fromName) {
        const n = Number(fromName[1])
        if (Number.isFinite(n) && n > 0) return n
      }
    }
  } catch {
    /* fall through */
  }
  return APP_VERSION_CODE
}
