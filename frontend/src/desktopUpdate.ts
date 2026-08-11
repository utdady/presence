import { formatVersionLabel } from './appVersion'
import { isPackedClient } from './api'

const REPO = 'utdady/presence'
const DISMISS_KEY = 'presence_desktop_update_dismissed'

export type DesktopOs = 'macos' | 'windows'

export type DesktopUpdateInfo = {
  os: DesktopOs
  installedBuild: number
  latestBuild: number
  installedLabel: string
  latestLabel: string
  downloadUrl: string
  releaseUrl: string
  assetName: string
}

function isTauriShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

export function detectDesktopOs(): DesktopOs | null {
  if (!isTauriShell() && !isPackedClient()) return null
  if (!isTauriShell()) return null
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('win')) return 'windows'
  return null
}

/** Parse 0.N / Beta 0.N / version 0.N.0 → N */
export function parseMarketingBuild(text: string): number | null {
  const m =
    text.match(/\bBeta\s+0\.(\d+)\b/i) ??
    text.match(/\b0\.(\d+)(?:\.0)?\b/) ??
    text.match(/versionCode:\s*(\d+)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

function pickAsset(
  os: DesktopOs,
  assets: { name: string; browser_download_url: string }[],
): { name: string; browser_download_url: string } | null {
  if (os === 'macos') {
    return (
      assets.find((a) => /Presence-macos-universal\.dmg$/i.test(a.name)) ??
      assets.find((a) => /\.dmg$/i.test(a.name)) ??
      null
    )
  }
  return (
    assets.find((a) => /x64-setup\.exe$/i.test(a.name)) ??
    assets.find((a) => /\.msi$/i.test(a.name)) ??
    null
  )
}

async function installedDesktopBuild(): Promise<number> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const v = await getVersion()
    return parseMarketingBuild(v) ?? 0
  } catch {
    return 0
  }
}

/**
 * Scan recent GitHub releases for a newer desktop installer for this OS.
 * (APK releases are often "latest", so we cannot rely on /releases/latest alone.)
 */
export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo | null> {
  const os = detectDesktopOs()
  if (!os) return null

  const installedBuild = await installedDesktopBuild()

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=30`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!res.ok) return null

  const releases = (await res.json()) as {
    html_url?: string
    name?: string
    tag_name?: string
    body?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name: string; browser_download_url: string }[]
  }[]

  let best: DesktopUpdateInfo | null = null

  for (const release of releases) {
    if (release.draft) continue
    const assets = release.assets ?? []
    const asset = pickAsset(os, assets)
    if (!asset) continue

    const latestBuild =
      parseMarketingBuild(release.name ?? '') ??
      parseMarketingBuild(release.body ?? '') ??
      parseMarketingBuild(asset.name) ??
      parseMarketingBuild(release.tag_name ?? '') ??
      0
    if (!latestBuild || latestBuild <= installedBuild) continue
    if (best && latestBuild <= best.latestBuild) continue

    best = {
      os,
      installedBuild,
      latestBuild,
      installedLabel:
        installedBuild > 0 ? formatVersionLabel(installedBuild) : 'unknown',
      latestLabel: formatVersionLabel(latestBuild),
      downloadUrl: asset.browser_download_url,
      releaseUrl:
        release.html_url ?? `https://github.com/${REPO}/releases`,
      assetName: asset.name,
    }
  }

  return best
}

export function wasDesktopUpdateDismissed(latestBuild: number): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === String(latestBuild)
  } catch {
    return false
  }
}

export function dismissDesktopUpdate(latestBuild: number): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(latestBuild))
  } catch {
    /* ignore */
  }
}

export function openDesktopDownload(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Terminal fix for Gatekeeper / quarantine on ad-hoc signed Mac builds. */
export const MAC_OPEN_FIX_COMMAND = `xattr -cr /Applications/Presence.app
open /Applications/Presence.app`

export const MAC_INSTALL_STEPS = `Install Presence on Mac
=======================

1. Download Presence-macos-universal.dmg from GitHub Releases.
2. Open the DMG and drag Presence into Applications.
3. Eject the DMG.

First launch (Gatekeeper)
-------------------------
This build is ad-hoc signed (not Apple notarized), so macOS may block a normal double-click.

Option A — Finder
1. Open Applications.
2. Control-click (or right-click) Presence.
3. Choose Open.
4. Click Open again in the dialog.

Option B — Terminal (copy all lines below, paste into Terminal, press Return)

${MAC_OPEN_FIX_COMMAND}

If it still says the app is damaged
-----------------------------------
1. Quit Presence if it is running.
2. Run the Terminal commands above again.
3. Or: System Settings → Privacy & Security → scroll for a blocked-app message → Open Anyway.

Camera / microphone for calls
-----------------------------
System Settings → Privacy & Security → Camera / Microphone → allow Presence.
`
