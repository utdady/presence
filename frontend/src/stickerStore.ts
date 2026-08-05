import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface StickerRecord {
  id: string
  name: string
  mime: string
  imageB64: string
  createdAt: number
}

interface StickerSchema extends DBSchema {
  stickers: {
    key: string
    value: StickerRecord
  }
}

export const STICKER_MAX_COUNT = 64

let dbPromise: Promise<IDBPDatabase<StickerSchema>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<StickerSchema>('presence-stickers', 1, {
      upgrade(db) {
        db.createObjectStore('stickers', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export async function listStickers(): Promise<StickerRecord[]> {
  const db = await getDb()
  const all = await db.getAll('stickers')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putSticker(record: StickerRecord): Promise<void> {
  const db = await getDb()
  const count = await db.count('stickers')
  if (count >= STICKER_MAX_COUNT && !(await db.get('stickers', record.id))) {
    throw new Error(`Sticker limit reached (${STICKER_MAX_COUNT})`)
  }
  await db.put('stickers', record)
}

export async function deleteSticker(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('stickers', id)
}
