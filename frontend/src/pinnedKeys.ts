/**
 * Persist peer identity public keys after first sight over the invite-gated hub.
 * Nearby and hub chat both check this store so a key swap can't go unnoticed.
 */

const STORAGE_KEY = 'presence_pinned_keys_v1'

export interface PinnedKey {
  peerId: string
  publicKey: string
  pinnedAt: number
}

export type PinObserveResult =
  | { status: 'new'; publicKey: string }
  | { status: 'match'; publicKey: string }
  | { status: 'mismatch'; pinned: string; received: string }

function loadAll(): Record<string, PinnedKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<PinnedKey>>
    const out: Record<string, PinnedKey> = {}
    for (const [id, row] of Object.entries(parsed)) {
      if (
        typeof row?.peerId === 'string' &&
        typeof row.publicKey === 'string' &&
        row.publicKey
      ) {
        out[id] = {
          peerId: row.peerId,
          publicKey: row.publicKey,
          pinnedAt: typeof row.pinnedAt === 'number' ? row.pinnedAt : Date.now(),
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, PinnedKey>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function getPinnedKey(peerId: string): string | null {
  return loadAll()[peerId]?.publicKey ?? null
}

export function findPeerIdByPublicKey(publicKey: string): string | null {
  for (const row of Object.values(loadAll())) {
    if (row.publicKey === publicKey) return row.peerId
  }
  return null
}

/** First sight pins; later sights must match or return mismatch (no overwrite). */
export function observePeerKey(
  peerId: string,
  publicKey: string,
): PinObserveResult {
  const all = loadAll()
  const existing = all[peerId]
  if (!existing) {
    all[peerId] = { peerId, publicKey, pinnedAt: Date.now() }
    saveAll(all)
    return { status: 'new', publicKey }
  }
  if (existing.publicKey === publicKey) {
    return { status: 'match', publicKey }
  }
  return {
    status: 'mismatch',
    pinned: existing.publicKey,
    received: publicKey,
  }
}

/** Explicit user confirmation after a key change or nearby verify. */
export function confirmPeerKey(peerId: string, publicKey: string): void {
  const all = loadAll()
  all[peerId] = { peerId, publicKey, pinnedAt: Date.now() }
  saveAll(all)
}

export type NearbyPinStatus = 'known' | 'unknown' | 'changed'

/** Classify a nearby hello against the pin store (by account id, then by key). */
export function nearbyPinStatus(
  userId: string,
  publicKey: string,
): NearbyPinStatus {
  const byId = getPinnedKey(userId)
  if (byId) {
    return byId === publicKey ? 'known' : 'changed'
  }
  if (findPeerIdByPublicKey(publicKey)) return 'known'
  return 'unknown'
}
