import { ErrorCodes, isNarsilError } from '@delali/narsil'
import { getNarsilClient } from './narsil/server-client'

const opening = new Map<string, Promise<void>>()

async function openNotesSpace(indexName: string): Promise<void> {
  const client = await getNarsilClient()
  try {
    const sync = await client.getSync(indexName)
    if (!sync.enabled) await client.updateSync(indexName, { enabled: true })
    return
  } catch (error) {
    if (!isNarsilError(error) || error.code !== ErrorCodes.INDEX_NOT_FOUND) throw error
  }
  try {
    await client.createIndex(indexName, {
      schema: { title: 'string', body: 'string' },
      language: 'english',
    })
  } catch (error) {
    if (!isNarsilError(error) || error.code !== ErrorCodes.INDEX_ALREADY_EXISTS) throw error
  }
  const sync = await client.getSync(indexName)
  if (!sync.enabled) await client.updateSync(indexName, { enabled: true })
}

export function ensureNotesSpace(indexName: string): Promise<void> {
  const existing = opening.get(indexName)
  if (existing !== undefined) return existing
  const pending = openNotesSpace(indexName).finally(() => opening.delete(indexName))
  opening.set(indexName, pending)
  return pending
}
