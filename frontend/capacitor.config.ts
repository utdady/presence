import type { CapacitorConfig } from '@capacitor/cli'

const LIVE_URL = 'https://presence-addy.fly.dev'

const config: CapacitorConfig = {
  appId: 'app.presence.nearby',
  appName: 'Presence',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    // Load the Fly-hosted SPA so `fly deploy` updates the app UI without a new native build.
    // Native Bluetooth plugin still requires a rebuilt app when plugin code changes.
    url: LIVE_URL,
    cleartext: false,
    allowNavigation: ['presence-addy.fly.dev'],
  },
  plugins: {},
}

export default config
