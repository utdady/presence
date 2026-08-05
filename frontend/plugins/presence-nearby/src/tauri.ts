import type {
  NearbyMessageEvent,
  NearbyPeer,
  PresenceNearbyPlugin,
} from './definitions'

type Unlisten = () => void

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  )
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

async function listen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<Unlisten> {
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen(event, (e) => handler(e.payload))
  return () => {
    void un()
  }
}

/** Capacitor-compatible nearby backend over Tauri commands + events. */
export class PresenceNearbyTauri implements PresenceNearbyPlugin {
  private listeners = new Map<string, Set<(p: unknown) => void>>()
  private unsubs: Unlisten[] = []
  private wired = false

  private async ensureEvents() {
    if (this.wired) return
    this.wired = true
    const wire = async (
      event: string,
      local: string,
    ) => {
      const un = await listen(event, (payload) => {
        for (const fn of this.listeners.get(local) ?? []) {
          fn(payload)
        }
      })
      this.unsubs.push(un)
    }
    await wire('nearby-peer-found', 'peerFound')
    await wire('nearby-peer-lost', 'peerLost')
    await wire('nearby-connected', 'connected')
    await wire('nearby-disconnected', 'disconnected')
    await wire('nearby-message', 'message')
    await wire('nearby-error', 'error')
  }

  async isAvailable(): Promise<{ available: boolean }> {
    await this.ensureEvents()
    return invoke('nearby_is_available')
  }

  async requestPermissions(): Promise<void> {
    await invoke('nearby_request_permissions')
  }

  async startAdvertising(options: { displayName: string }): Promise<void> {
    await invoke('nearby_start_advertising', {
      displayName: options.displayName,
    })
  }

  async startDiscovery(): Promise<void> {
    await invoke('nearby_start_discovery')
  }

  async stop(): Promise<void> {
    await invoke('nearby_stop')
  }

  async connect(options: {
    endpointId: string
    displayName?: string
  }): Promise<void> {
    await invoke('nearby_connect', {
      endpointId: options.endpointId,
      displayName: options.displayName,
    })
  }

  async disconnect(): Promise<void> {
    await invoke('nearby_disconnect')
  }

  async send(options: { data: string }): Promise<void> {
    await invoke('nearby_send', { data: options.data })
  }

  async setSpeakerphone(): Promise<void> {
    /* Windows desktop has no earpiece route */
  }

  async addListener(
    eventName: 'peerFound',
    listenerFunc: (peer: NearbyPeer) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName: 'peerLost',
    listenerFunc: (peer: { id: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName: 'connected',
    listenerFunc: (peer: NearbyPeer) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName: 'disconnected',
    listenerFunc: (peer: { id: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName: 'message',
    listenerFunc: (event: NearbyMessageEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName: 'error',
    listenerFunc: (event: { message: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  async addListener(
    eventName:
      | 'peerFound'
      | 'peerLost'
      | 'connected'
      | 'disconnected'
      | 'message'
      | 'error',
    listenerFunc: (event: never) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    await this.ensureEvents()
    let set = this.listeners.get(eventName)
    if (!set) {
      set = new Set()
      this.listeners.set(eventName, set)
    }
    const fn = listenerFunc as (p: unknown) => void
    set.add(fn)
    return {
      remove: async () => {
        set?.delete(fn)
      },
    }
  }
}

export function tryCreateTauriNearby(): PresenceNearbyPlugin | null {
  if (!isTauri()) return null
  return new PresenceNearbyTauri()
}
