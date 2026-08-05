import { WebPlugin } from '@capacitor/core'
import type { PresenceNearbyPlugin } from './definitions'

export class PresenceNearbyWeb extends WebPlugin implements PresenceNearbyPlugin {
  async isAvailable(): Promise<{ available: boolean }> {
    return { available: false }
  }

  async requestPermissions(): Promise<void> {
    throw this.unavailable('Nearby calls require the Android app')
  }

  async startAdvertising(): Promise<void> {
    throw this.unavailable('Nearby calls require the Android app')
  }

  async startDiscovery(): Promise<void> {
    throw this.unavailable('Nearby calls require the Android app')
  }

  async stop(): Promise<void> {}

  async connect(): Promise<void> {
    throw this.unavailable('Nearby calls require the Android app')
  }

  async disconnect(): Promise<void> {}

  async send(): Promise<void> {
    throw this.unavailable('Nearby calls require the Android app')
  }

  async setSpeakerphone(): Promise<void> {
    /* no-op on web */
  }
}