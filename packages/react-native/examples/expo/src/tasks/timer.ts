import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { type CorpusDocument, corpus, queryVectors } from '../corpus'
import { SEARCH_SCHEMA } from './search'

const TIMER_DIRECTORY = 'timer-check'
const TIMER_INDEX = 'timer'
const IMPORTED_INDEX = 'imported'
const TIMER_DOCUMENTS = 50_000
const IN_MEMORY_DOCUMENTS = 20_000
const TIMER_PARTITIONS = 8
const WRITE_BATCH = 2_000
const TIMER_INTERVAL_MS = 10
const EXPORT_FILE = 'timer-export.ndjson'
const LONG_SEARCH = 'zorbek quilon trevac mirdel oskaro fenark borvan cindrl'
const LONG_SEARCH_TOLERANCE = 2
const UPDATED_YEAR_SHIFT = 1

export interface TimedWork {
  workMs: number
  ticks: number
  longestGapMs: number
}

export interface TimerReport {
  intervalMs: number
  documents: number
  partitions: number
  inserting: TimedWork
  insertingInMemory: TimedWork & { documents: number }
  search: TimedWork & { count: number }
  vectorSearch: TimedWork & { count: number }
  updating: TimedWork & { updated: number }
  importing: TimedWork & { imported: number; refusedCount: number }
  removing: TimedWork & { removed: number }
}

function timedWork(work: TimedWork): TimedWork {
  return { workMs: work.workMs, ticks: work.ticks, longestGapMs: work.longestGapMs }
}

async function whileTicking<T>(work: () => Promise<T>): Promise<{ value: T } & TimedWork> {
  const ticks: number[] = []
  const timer = setInterval(() => ticks.push(performance.now()), TIMER_INTERVAL_MS)
  const started = performance.now()
  try {
    const value = await work()
    const ended = performance.now()
    let longestGapMs = 0
    let previous = started
    for (const tick of ticks) {
      longestGapMs = Math.max(longestGapMs, tick - previous)
      previous = tick
    }
    longestGapMs = Math.max(longestGapMs, ended - previous)
    return { value, workMs: ended - started, ticks: ticks.length, longestGapMs }
  } finally {
    clearInterval(timer)
  }
}

async function fill(narsil: PhoneNarsil, documents: CorpusDocument[]): Promise<void> {
  await narsil.createIndex(TIMER_INDEX, {
    schema: SEARCH_SCHEMA,
    language: 'english',
    partitions: { maxPartitions: TIMER_PARTITIONS },
  })
  for (let start = 0; start < documents.length; start += WRITE_BATCH) {
    const result = await narsil.insertBatch(TIMER_INDEX, documents.slice(start, start + WRITE_BATCH))
    if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to insert`)
  }
}

async function update(narsil: PhoneNarsil, documents: CorpusDocument[]): Promise<number> {
  const updates = documents.slice(0, WRITE_BATCH).map(({ id, ...fields }) => ({
    docId: id,
    document: { ...fields, year: fields.year + UPDATED_YEAR_SHIFT },
  }))
  const result = await narsil.updateBatch(TIMER_INDEX, updates)
  if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to update`)
  return result.succeeded.length
}

async function remove(narsil: PhoneNarsil, documents: CorpusDocument[]): Promise<number> {
  const docIds = documents.slice(documents.length - WRITE_BATCH).map(document => document.id)
  const result = await narsil.removeBatch(TIMER_INDEX, docIds)
  if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to remove`)
  return result.succeeded.length
}

async function openEmpty(): Promise<PhoneNarsil> {
  const narsil = await createNarsil({ durability: { directory: TIMER_DIRECTORY } })
  for (const index of await narsil.listIndexes()) await narsil.dropIndex(index.name)
  return narsil
}

async function insertInMemory(documents: CorpusDocument[]): Promise<{ value: void } & TimedWork> {
  const narsil = await createNarsil({ durability: null })
  try {
    return await whileTicking(() => fill(narsil, documents))
  } finally {
    await narsil.shutdown()
  }
}

export async function runTimerTask(): Promise<TimerReport> {
  const documents = corpus(TIMER_DOCUMENTS)
  const insertingInMemory = await insertInMemory(documents.slice(0, IN_MEMORY_DOCUMENTS))
  const narsil = await openEmpty()
  try {
    const inserting = await whileTicking(() => fill(narsil, documents))
    const [queryVector] = queryVectors(1)
    const vectorSearch = await whileTicking(() =>
      narsil.query(TIMER_INDEX, { mode: 'vector', vector: { field: 'embedding', value: queryVector }, limit: 10 }),
    )
    const search = await whileTicking(() =>
      narsil.query(TIMER_INDEX, {
        term: LONG_SEARCH,
        tolerance: LONG_SEARCH_TOLERANCE,
        facets: { year: {} },
        sort: { year: 'desc' },
        limit: 10,
      }),
    )
    const updating = await whileTicking(() => update(narsil, documents))
    await narsil.exportDocumentsToFile(TIMER_INDEX, EXPORT_FILE)
    const importing = await whileTicking(() => narsil.importDocumentExportFromFile(IMPORTED_INDEX, EXPORT_FILE))
    const removing = await whileTicking(() => remove(narsil, documents))
    return {
      intervalMs: TIMER_INTERVAL_MS,
      documents: TIMER_DOCUMENTS,
      partitions: TIMER_PARTITIONS,
      inserting: timedWork(inserting),
      insertingInMemory: { ...timedWork(insertingInMemory), documents: IN_MEMORY_DOCUMENTS },
      search: { ...timedWork(search), count: search.value.count },
      vectorSearch: { ...timedWork(vectorSearch), count: vectorSearch.value.count },
      updating: { ...timedWork(updating), updated: updating.value },
      importing: {
        ...timedWork(importing),
        imported: importing.value.imported,
        refusedCount: importing.value.refusedCount,
      },
      removing: { ...timedWork(removing), removed: removing.value },
    }
  } finally {
    await narsil.shutdown()
  }
}
