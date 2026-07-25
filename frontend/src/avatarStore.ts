import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface AvatarRecord {
  userId: string
  version: string
  mime: 'image/jpeg'
  imageB64: string
  updatedAt: number
}

interface AvatarSchema extends DBSchema {
  avatars: {
    key: string
    value: AvatarRecord
  }
}

let dbPromise: Promise<IDBPDatabase<AvatarSchema>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<AvatarSchema>('presence-avatars', 1, {
      upgrade(db) {
        db.createObjectStore('avatars')
      },
    })
  }
  return dbPromise
}

export async function getAvatar(userId: string): Promise<AvatarRecord | undefined> {
  const db = await getDb()
  return db.get('avatars', userId)
}

export async function putAvatar(record: AvatarRecord): Promise<void> {
  const db = await getDb()
  await db.put('avatars', record, record.userId)
}

export async function deleteAvatar(userId: string): Promise<void> {
  const db = await getDb()
  await db.delete('avatars', userId)
}

export async function listAvatars(): Promise<AvatarRecord[]> {
  const db = await getDb()
  return db.getAll('avatars')
}
