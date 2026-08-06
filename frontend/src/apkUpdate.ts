import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { formatVersionLabel, marketingVersion } from './appVersion'

const REPO = 'utdady/presence'
const DISMISS_KEY = 'presence_apk_update_dismissed'

export type ApkUpdateInfo = {
  /** Integer versionCode (compare with this only). */
  installedBuild: number
  latestBuild: number
  installedLabel: string
  latestLabel: string
  downloadUrl: string
  releaseUrl: string
}

/** Parse integer versionCode from release notes / title. */
function parseVersionCode(text: string): number | null {
  const m =
    text.match(/versionCode:\s*(\d+)/i) ??
    text.match(/build\s+(\d+)\b/i) ??
    text.match(/\b0\.(\d+)\b/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function checkApkUpdate(): Promise<ApkUpdateInfo | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return null
  }

  let installedBuild = 0
  try {
    const info = await App.getInfo()
    installedBuild = Number.parseInt(info.build, 10) || 0
  } catch {
    // Older APKs may lack the App plugin — treat as build 0 so the banner still shows.
    installedBuild = 0
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!res.ok) return null

  const release = (await res.json()) as {
    html_url?: string
    name?: string
    body?: string
    assets?: { name: string; browser_download_url: string }[]
  }

  const latestBuild =
    parseVersionCode(release.body ?? '') ??
    parseVersionCode(release.name ?? '') ??
    0
  if (!latestBuild || latestBuild <= installedBuild) return null

  const asset = release.assets?.find((a) => a.name === 'presence-debug.apk')
  const downloadUrl =
    asset?.browser_download_url ??
    `https://github.com/${REPO}/releases/latest/download/presence-debug.apk`

  return {
    installedBuild,
    latestBuild,
    installedLabel:
      installedBuild > 0
        ? formatVersionLabel(installedBuild)
        : 'unknown',
    latestLabel: formatVersionLabel(latestBuild),
    downloadUrl,
    releaseUrl:
      release.html_url ?? `https://github.com/${REPO}/releases/latest`,
  }
}

export function wasUpdateDismissed(latestBuild: number): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === String(latestBuild)
  } catch {
    return false
  }
}

export function dismissUpdate(latestBuild: number): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(latestBuild))
  } catch {
    /* ignore */
  }
}

/** Open the APK URL so Android's download manager / browser can install it. */
export function openApkDownload(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export { marketingVersion }
