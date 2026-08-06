import type { ApkUpdateInfo } from '../apkUpdate'
import { dismissUpdate, openApkDownload } from '../apkUpdate'

export function ApkUpdateBanner({
  update,
  onDismiss,
}: {
  update: ApkUpdateInfo
  onDismiss: () => void
}) {
  return (
    <div className="apk-update-banner" role="status">
      <p>
        APK update available ({update.latestLabel}; you have{' '}
        {update.installedLabel}). Install, then open the new APK.
      </p>
      <div className="apk-update-actions">
        <button
          type="button"
          className="ghost-btn apk-update-download"
          onClick={() => openApkDownload(update.downloadUrl)}
        >
          Download update
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            dismissUpdate(update.latestBuild)
            onDismiss()
          }}
        >
          Later
        </button>
      </div>
    </div>
  )
}
