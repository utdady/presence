import { useState } from 'react'
import {
  MAC_INSTALL_STEPS,
  MAC_OPEN_FIX_COMMAND,
  detectDesktopOs,
} from '../desktopUpdate'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** In-app Mac Gatekeeper help with one-click copy for Terminal. */
export function MacInstallHelp() {
  const os = detectDesktopOs()
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [copiedAll, setCopiedAll] = useState(false)
  const [open, setOpen] = useState(false)

  if (os !== 'macos') return null

  return (
    <div className="mac-install-help">
      <button
        type="button"
        className="sidebar-settings-action"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Can&apos;t open on Mac? Help
      </button>
      {open && (
        <div className="mac-install-help-body">
          <p className="mac-install-help-lead">
            If macOS says Presence is damaged or can&apos;t be opened, clear
            quarantine in Terminal, then open the app.
          </p>
          <ol className="mac-install-help-steps">
            <li>Open <strong>Terminal</strong> (Spotlight → Terminal).</li>
            <li>Click <strong>Copy commands</strong> below.</li>
            <li>Paste into Terminal (⌘V) and press Return.</li>
            <li>
              If asked, allow Camera and Microphone under System Settings →
              Privacy &amp; Security.
            </li>
          </ol>
          <pre className="mac-install-help-code" tabIndex={0}>
            {MAC_OPEN_FIX_COMMAND}
          </pre>
          <div className="mac-install-help-actions">
            <button
              type="button"
              className="sidebar-settings-action mac-install-help-copy"
              onClick={() => {
                void copyText(MAC_OPEN_FIX_COMMAND).then((ok) => {
                  if (!ok) return
                  setCopiedCmd(true)
                  window.setTimeout(() => setCopiedCmd(false), 2000)
                })
              }}
            >
              {copiedCmd ? 'Copied!' : 'Copy commands'}
            </button>
            <button
              type="button"
              className="sidebar-settings-action mac-install-help-copy"
              onClick={() => {
                void copyText(MAC_INSTALL_STEPS).then((ok) => {
                  if (!ok) return
                  setCopiedAll(true)
                  window.setTimeout(() => setCopiedAll(false), 2000)
                })
              }}
            >
              {copiedAll ? 'Copied!' : 'Copy full instructions'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
