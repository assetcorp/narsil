import type { AnyDocument, Narsil } from '@delali/narsil'
import { createDeviceSync, type DeviceSync, type DeviceSyncStore } from '@delali/narsil/sync'
import { createIndexedDBDeviceStore } from '@delali/narsil/sync/indexeddb'
import { MAX_SYNC_INDEX_NAME_LENGTH, readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import * as v from 'valibot'
import type { DeviceSyncView, SyncStartRequest } from './protocol'

const SYNC_LOCK_PREFIX = 'narsil-browser-demo-sync:'
const SYNC_STORE_PREFIX = 'narsil-browser-demo-sync-'
const MAX_GRANT_RESPONSE_BYTES = 4_096

const GrantAnswerSchema = v.object({ credential: v.pipe(v.string(), v.minLength(1)) })

interface SyncSession {
  indexName: string
  serverUrl: string
  sync: DeviceSync
  store: DeviceSyncStore
  releaseLock: () => void
  lastError: string | null
  refusedWrites: number
}

const sessions = new Map<string, SyncSession>()

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fetchGrant(grantUrl: string, indexName: string): Promise<string> {
  const response = await fetch(grantUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ indexName }),
    cache: 'no-store',
  })
  const text = await readBoundedText(response, MAX_GRANT_RESPONSE_BYTES)
  if (text === null) throw new Error('The sync grant answer is too large')
  if (!response.ok) throw new Error(`The app refused a sync grant (status ${response.status}): ${text}`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('The sync grant answer is not JSON')
  }
  const parsed = v.safeParse(GrantAnswerSchema, body)
  if (!parsed.success) throw new Error('The sync grant answer holds no credential')
  return parsed.output.credential
}

function holdLock(indexName: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(`${SYNC_LOCK_PREFIX}${indexName}`, { ifAvailable: true }, lock => {
        if (lock === null) {
          resolve(null)
          return undefined
        }
        return new Promise<void>(release => {
          resolve(release)
        })
      })
      .catch(reject)
  })
}

export function syncedSession(indexName: string): DeviceSync | null {
  return sessions.get(indexName)?.sync ?? null
}

export async function isSyncedElsewhere(indexName: string): Promise<boolean> {
  if (sessions.has(indexName)) return false
  const state = await navigator.locks.query()
  return (state.held ?? []).some(lock => lock.name === `${SYNC_LOCK_PREFIX}${indexName}`)
}

export function describeSessions(): DeviceSyncView[] {
  return [...sessions.values()].map(session => {
    const status = session.sync.status()
    return {
      indexName: session.indexName,
      serverUrl: session.serverUrl,
      connection: status.connection,
      queuedWrites: status.queuedWrites,
      epoch: status.position?.epoch ?? null,
      lastError: session.lastError,
      refusedWrites: session.refusedWrites,
    }
  })
}

export async function startSync(engine: Narsil, request: SyncStartRequest): Promise<DeviceSyncView[]> {
  const { indexName, serverUrl, grantUrl } = request
  if (indexName.length === 0 || indexName.length > MAX_SYNC_INDEX_NAME_LENGTH) {
    throw new Error(`Give the index a name of 1 to ${MAX_SYNC_INDEX_NAME_LENGTH} characters.`)
  }
  if (sessions.has(indexName)) return describeSessions()

  const releaseLock = await holdLock(indexName)
  if (releaseLock === null) {
    throw new Error(
      `Another tab syncs ${indexName}. This tab sees every change it applies, and its edits go through that tab.`,
    )
  }

  let store: DeviceSyncStore | null = null
  try {
    store = await createIndexedDBDeviceStore({ databaseName: `${SYNC_STORE_PREFIX}${indexName}` })
    const opened = store
    const session: SyncSession = {
      indexName,
      serverUrl,
      store: opened,
      releaseLock,
      lastError: null,
      refusedWrites: 0,
      sync: createDeviceSync({
        engine,
        indexName,
        url: serverUrl,
        store: opened,
        credential: () => fetchGrant(grantUrl, indexName),
        onError: err => {
          session.lastError = errorText(err)
        },
        onRefusedWrite: refused => {
          session.refusedWrites += 1
          session.lastError = `The server refused the write of ${refused.write.documentId}: ${refused.error.message}`
        },
      }),
    }
    sessions.set(indexName, session)
    await session.sync.start()
    return describeSessions()
  } catch (err) {
    sessions.delete(indexName)
    await store?.close().catch(() => undefined)
    releaseLock()
    throw err
  }
}

export async function stopSync(indexName: string): Promise<DeviceSyncView[]> {
  const session = sessions.get(indexName)
  if (session === undefined) return describeSessions()
  sessions.delete(indexName)
  try {
    await session.sync.stop()
    await session.store.close()
  } finally {
    session.releaseLock()
  }
  return describeSessions()
}

export async function writeThroughSync(
  indexName: string,
  documentId: string,
  document: AnyDocument | null,
): Promise<boolean> {
  const sync = syncedSession(indexName)
  if (sync === null) return false
  if (document === null) {
    await sync.remove(documentId)
  } else {
    await sync.put(documentId, document)
  }
  return true
}
