import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.presence.nearby',
  appName: 'Presence',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {},
}

export default config