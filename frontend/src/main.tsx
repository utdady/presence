import { Capacitor } from '@capacitor/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

function isTauriShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

async function boot() {
  // No service worker inside Capacitor WebView or Tauri (online API is Fly).
  if (!Capacitor.isNativePlatform() && !isTauriShell()) {
    const { registerSW } = await import('virtual:pwa-register')
    registerSW({
      immediate: true,
      // New SW after CSP/deploy fixes — reload so mobile isn't stuck on a
      // precached shell that still has the broken Content-Security-Policy.
      onRegisteredSW(_url, registration) {
        void registration?.update()
      },
      onNeedRefresh() {
        window.location.reload()
      },
    })
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
