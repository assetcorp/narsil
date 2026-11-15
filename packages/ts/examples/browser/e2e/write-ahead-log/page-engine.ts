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
