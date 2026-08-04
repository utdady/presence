import { Capacitor } from '@capacitor/core'
import { PresenceNearby } from 'presence-nearby'
import { isPackedClient } from '../api'

export type NearbyTransport = 'native' | 'lan' | 'none'

export async function nearbyTransport(): Promise<NearbyTransport> {
  // Capacitor Android or Tauri desktop with Bluetooth.
  if (isPackedClient() || Capacitor.isNativePlatform()) {
    try {
      const res = await PresenceNearby.isAvailable()
      if (res.available) return 'native'
    } catch {
      /* fall through */
    }
  }
  return 'lan'
}

export async function nearbyCallsAvailable(): Promise<boolean> {
  return (await nearbyTransport()) !== 'none'
}
