import { createNarsil, type DurabilityConfig, type Narsil } from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'

export interface LogScenario {
  dbName: string
  durability?: DurabilityConfig
}

export interface ReadBack {
  count: number
  titles: Array<string | null>
}

type Acknowledge = (docId: string, title: string) => Promise<void>

const NOTES = 'notes'
const MAX_INSERTS = 5_000

const writers: Narsil[] = []

function open(scenario: LogScenario): Promise<Narsil> {
  return createNarsil({
    persistence: createIndexedDBPersistence({ dbName: scenario.dbName }),
    ...(scenario.durability === undefined ? {} : { durability: scenario.durability }),
  })
}

async function insertUntilStopped(engine: Narsil, acknowledge: Acknowledge): Promise<void> {
  for (let at = 0; at < MAX_INSERTS; at++) {
    const docId = `note-${at}`
    const title = `note ${at} written at ${performance.now().toFixed(3)}`
    await engine.insert(NOTES, { title }, docId)
    await acknowledge(docId, title)
  }
}

export async function startWriting(scenario: LogScenario, acknowledge: Acknowledge): Promise<void> {
  const engine = await open(scenario)
  writers.push(engine)
  await engine.createIndex(NOTES, { schema: { title: 'string' } })
  void insertUntilStopped(engine, acknowledge)
}

export interface LossReport {
  refusedWith: string | null
  reported: string[]
}

interface WatchedEngine {
  engine: Narsil
  reported: string[]
}

let watched: WatchedEngine | undefined

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : String(error)
}

export async function openWatched(scenario: LogScenario): Promise<void> {
  const engine = await open(scenario)
  const reported: string[] = []
  engine.on('durabilityError', ({ error }) => reported.push(codeOf(error)))
  await engine.createIndex(NOTES, { schema: { title: 'string' } })
  await engine.insert(NOTES, { title: 'written before the store was cleared' }, 'kept')
  watched = { engine, reported }
}

export async function insertAfterStorageCleared(): Promise<LossReport> {
  if (watched === undefined) throw new Error('openWatched must open an engine first')
  const { engine, reported } = watched
  try {
    await engine.insert(NOTES, { title: 'written after the store was cleared' }, 'refused')
    return { refusedWith: null, reported: [...reported] }
  } catch (error) {
    return { refusedWith: codeOf(error), reported: [...reported] }
  }
}

export function reportedErrors(): string[] {
  return watched === undefined ? [] : [...watched.reported]
}

export async function readBack(scenario: LogScenario, docIds: string[]): Promise<ReadBack> {
  const engine = await open(scenario)
  try {
    const count = await engine.countDocuments(NOTES)
    const titles: Array<string | null> = []
    for (const docId of docIds) {
      const document = await engine.get(NOTES, docId)
      titles.push(typeof document?.title === 'string' ? document.title : null)
    }
    return { count, titles }
  } finally {
    await engine.shutdown()
  }
}

export async function writeDuringUpgrade(scenario: LogScenario): Promise<LossReport> {
  const engine = await open({ ...scenario, durability: { mode: 'async', flushIntervalMs: 600_000 } })
  const reported: string[] = []
  engine.on('durabilityError', ({ error }) => reported.push(codeOf(error)))
  try {
    await engine.createIndex(NOTES, { schema: { title: 'string' } })
    await engine.insert(NOTES, { title: 'before the version change' }, 'kept')
    const request = indexedDB.open(scenario.dbName)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let holding = true
    const store = database.transaction('partitions', 'readwrite').objectStore('partitions')
    function keepTransactionOpen(): void {
      const read = store.get('notes/meta')
      read.onsuccess = () => {
        if (holding) keepTransactionOpen()
      }
    }
    keepTransactionOpen()
    database.onversionchange = () => {
      holding = false
      database.close()
    }
    const pending = engine.insert(NOTES, { title: 'during the version change' }, 'refused').then(
      () => null,
      error => codeOf(error),
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      const upgrade = indexedDB.open(scenario.dbName, 2)
      await new Promise<void>((resolve, reject) => {
        upgrade.onsuccess = () => {
          upgrade.result.close()
          resolve()
        }
        upgrade.onerror = () => reject(upgrade.error)
      })
      return { refusedWith: await pending, reported }
    } finally {
      holding = false
      database.close()
      await pending
    }
  } finally {
    await engine.shutdown()
  }
}
