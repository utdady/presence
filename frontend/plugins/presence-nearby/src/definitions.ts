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
  /** Prompt Bluetooth permissions (BLE advertise/scan/connect). */
  requestPermissions(): Promise<void>
  startAdvertising(options: { displayName: string }): Promise<void>
  startDiscovery(): Promise<void>
  stop(): Promise<void>
  connect(options: { endpointId: string; displayName?: string }): Promise<void>
  disconnect(): Promise<void>
  send(options: { data: string }): Promise<void>
  /** Android: route call audio to loudspeaker (true) or earpiece (false). */
  setSpeakerphone(options: { on: boolean }): Promise<void>
  /**
   * Android: launcher badge = count of online friends (0 clears).
   * Uses a silent status notification so OEM badge counters update.
   */
  setAppBadge(options: { count: number }): Promise<void>
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