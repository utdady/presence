import { registerPlugin } from '@capacitor/core'
import type { PresenceNearbyPlugin } from './definitions'
import { tryCreateTauriNearby } from './tauri'
import { PresenceNearbyWeb } from './web'

function createPlugin(): PresenceNearbyPlugin {
  const tauri = tryCreateTauriNearby()
  if (tauri) return tauri
  return registerPlugin<PresenceNearbyPlugin>('PresenceNearby', {
    web: () => new PresenceNearbyWeb(),
  })
}

export const PresenceNearby = createPlugin()

export * from './definitions'
