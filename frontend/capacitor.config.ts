import type { CapacitorConfig } from '@capacitor/cli'

const LIVE_URL = 'https://presence-addy.fly.dev'

const config: CapacitorConfig = {
  appId: 'app.presence.nearby',
  appName: 'Presence',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Load the Fly-hosted SPA so `fly deploy` updates the app UI without a new APK.
    // Native Bluetooth plugin still requires a rebuilt APK when Java/plugin code changes.
    url: LIVE_URL,
    cleartext: false,
  },
  plugins: {},
}

export default config
