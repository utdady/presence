import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import sodium from 'libsodium-wrappers'
import type { PlainPayload } from './types'

interface KeySchema extends DBSchema {
  identity: {
    key: string
    value: {
      id: 'self'
      publicKey: string
      privateKey: string
    }
  }
}

let dbPromise: Promise<IDBPDatabase<KeySchema>> | null = null
let ready = false

async function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<KeySchema>('presence-keys', 1, {
      upgrade(db) {
        db.createObjectStore('identity')
      },
    })
  }
  return dbPromise
}

export async function initCrypto(): Promise<void> {
  await sodium.ready
  ready = true
}

function assertReady() {
  if (!ready) throw new Error('Crypto not initialized')
}

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
}

function fromB64(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL)
}

export async function getOrCreateIdentityKeypair(): Promise<{
  publicKey: string
  privateKey: string
}> {
  assertReady()
  const db = await getDb()
  const existing = await db.get('identity', 'self')
  if (existing) {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey }
  }
  const kp = sodium.crypto_box_keypair()
  const record = {
    id: 'self' as const,
    publicKey: b64(kp.publicKey),
    privateKey: b64(kp.privateKey),
  }
  await db.put('identity', record, 'self')
  return { publicKey: record.publicKey, privateKey: record.privateKey }
}

/**
 * Derive a stable identity keypair from username+password so every device
 * that signs in as the same account shares one E2E identity.
 */
export async function deriveAndStoreIdentityKeypair(
  username: string,
  password: string,
): Promise<{ publicKey: string; privateKey: string }> {
  assertReady()
  const uname = username.trim().toLowerCase()
  const salt = sodium.crypto_generichash(
    sodium.crypto_pwhash_SALTBYTES,
    sodium.from_string(`presence-id-v1:${uname}`),
    null,
  )
  const seed = sodium.crypto_pwhash(
    sodium.crypto_box_SEEDBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_DEFAULT,
  )
  const kp = sodium.crypto_box_seed_keypair(seed)
  const record = {
    id: 'self' as const,
    publicKey: b64(kp.publicKey),
    privateKey: b64(kp.privateKey),
  }
  const db = await getDb()
  await db.put('identity', record, 'self')
  return { publicKey: record.publicKey, privateKey: record.privateKey }
}

/** X25519 shared secret via crypto_box_beforenm, then BLAKE2b-256 (HKDF-like). */
export function deriveSessionKey(
  myPrivateKeyB64: string,
  peerPublicKeyB64: string,
): Uint8Array {
  assertReady()
  const shared = sodium.crypto_box_beforenm(
    fromB64(peerPublicKeyB64),
    fromB64(myPrivateKeyB64),
  )
  return sodium.crypto_generichash(
    32,
    shared,
    sodium.from_string('presence-v0-session'),
  )
}

export function encryptPayload(sessionKey: Uint8Array, plain: PlainPayload): string {
  assertReady()
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES,
  )
  const message = sodium.from_string(JSON.stringify(plain))
  const cipher = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
    message,
    null,
    null,
    nonce,
    sessionKey,
  )
  const packed = new Uint8Array(nonce.length + cipher.length)
  packed.set(nonce, 0)
  packed.set(cipher, nonce.length)
  return b64(packed)
}

export function decryptPayload(
  sessionKey: Uint8Array,
  payloadB64: string,
): PlainPayload | null {
  assertReady()
  try {
    const packed = fromB64(payloadB64)
    const nonceLen = sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES
    const nonce = packed.slice(0, nonceLen)
    const cipher = packed.slice(nonceLen)
    const message = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      null,
      cipher,
      null,
      nonce,
      sessionKey,
    )
    return JSON.parse(sodium.to_string(message)) as PlainPayload
  } catch {
    return null
  }
}

export function newMsgId(): string {
  assertReady()
  return b64(sodium.randombytes_buf(12))
}


export function encryptJson(sessionKey: Uint8Array, value: unknown): string {
  assertReady()
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES,
  )
  const message = sodium.from_string(JSON.stringify(value))
  const cipher = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
    message,
    null,
    null,
    nonce,
    sessionKey,
  )
  const packed = new Uint8Array(nonce.length + cipher.length)
  packed.set(nonce, 0)
  packed.set(cipher, nonce.length)
  return b64(packed)
}

export function decryptJson<T = unknown>(
  sessionKey: Uint8Array,
  payloadB64: string,
): T | null {
  assertReady()
  try {
    const packed = fromB64(payloadB64)
    const nonceLen = sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES
    const nonce = packed.slice(0, nonceLen)
    const cipher = packed.slice(nonceLen)
    const message = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      null,
      cipher,
      null,
      nonce,
      sessionKey,
    )
    return JSON.parse(sodium.to_string(message)) as T
  } catch {
    return null
  }
}

/** Short human-check fingerprint of a public key. */
export function keyFingerprint(publicKeyB64: string): string {
  assertReady()
  const digest = sodium.crypto_generichash(
    8,
    fromB64(publicKeyB64),
    sodium.from_string('presence-nearby-fp'),
  )
  return sodium.to_hex(digest).toUpperCase()
}