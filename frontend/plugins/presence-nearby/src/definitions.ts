export interface NearbyPeer {
  id: string
  name: string
}

export interface NearbyMessageEvent {
  peerId: string
  data: string
}

export interface PresenceNearbyPlugin {
  isAvailable(): Promise<{ available: boolean }>
  /** Prompt Bluetooth (and Location on Android 6–11 for classic scan) permissions. */
  requestPermissions(): Promise<void>
  startAdvertising(options: { displayName: string }): Promise<void>
  startDiscovery(): Promise<void>
  stop(): Promise<void>
  connect(options: { endpointId: string; displayName?: string }): Promise<void>
  disconnect(): Promise<void>
  send(options: { data: string }): Promise<void>
  addListener(
    eventName: 'peerFound',
    listenerFunc: (peer: NearbyPeer) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'peerLost',
    listenerFunc: (peer: { id: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'connected',
    listenerFunc: (peer: NearbyPeer) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'disconnected',
    listenerFunc: (peer: { id: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'message',
    listenerFunc: (event: NearbyMessageEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'error',
    listenerFunc: (event: { message: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}