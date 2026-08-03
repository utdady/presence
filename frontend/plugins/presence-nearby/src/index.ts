import { registerPlugin } from '@capacitor/core'
import type { PresenceNearbyPlugin } from './definitions'
import { PresenceNearbyWeb } from './web'

const PresenceNearby = registerPlugin<PresenceNearbyPlugin>('PresenceNearby', {
  web: () => new PresenceNearbyWeb(),
})

export * from './definitions'
export { PresenceNearby }