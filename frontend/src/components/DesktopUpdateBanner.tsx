import type { DesktopUpdateInfo } from '../desktopUpdate'
import { dismissDesktopUpdate, openDesktopDownload } from '../desktopUpdate'

export function DesktopUpdateBanner({
  update,
  onDismiss,
}: {
  update: DesktopUpdateInfo
  onDismiss: () => void
}) {
  const kind = update.os === 'macos' ? 'Mac' : 'Windows'
  return (
    <div className="apk-update-banner" role="status">
      <p>
        {kind} update available ({update.latestLabel}; you have{' '}
        {update.installedLabel}). Download, then replace the app in Applications
        {update.os === 'windows' ? ' / re-run the installer' : ''}.
      </p>
      <div className="apk-update-actions">
        <button
          type="button"
          className="ghost-btn apk-update-download"
          onClick={() => openDesktopDownload(update.downloadUrl)}
        >
          Download {update.os === 'macos' ? 'DMG' : 'installer'}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            dismissDesktopUpdate(update.latestBuild)
            onDismiss()
          }}
        >
          Later
        </button>
      </div>
    </div>
  )
}
