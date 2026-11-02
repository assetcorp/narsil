import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { corpus } from '../corpus'
import { SEARCH_SCHEMA } from './search'

const TIMER_INDEX = 'timer'
const IMPORTED_INDEX = 'imported'
const TIMER_DOCUMENTS = 50_000
const INSERT_BATCH = 2_000
const TIMER_INTERVAL_MS = 10
const EXPORT_FILE = 'timer-export.ndjson'
const LONG_SEARCH = 'zorbek quilon trevac mirdel oskaro fenark borvan cindrl'
const LONG_SEARCH_TOLERANCE = 2

export interface TimedWork {
  workMs: number
  ticks: number
  longestGapMs: number
}

export interface TimerReport {
  intervalMs: number
  documents: number
  search: TimedWork & { count: number }
  importing: TimedWork & { imported: number; refusedCount: number }
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

async function fill(narsil: PhoneNarsil): Promise<void> {
  await narsil.createIndex(TIMER_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
  const documents = corpus(TIMER_DOCUMENTS)
  for (let start = 0; start < documents.length; start += INSERT_BATCH) {
    const result = await narsil.insertBatch(TIMER_INDEX, documents.slice(start, start + INSERT_BATCH))
    if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to insert`)
  }
}

export async function runTimerTask(): Promise<TimerReport> {
  const narsil = await createNarsil({ durability: null })
  try {
    await fill(narsil)
    const search = await whileTicking(() =>
      narsil.query(TIMER_INDEX, {
        term: LONG_SEARCH,
        tolerance: LONG_SEARCH_TOLERANCE,
        facets: { year: {} },
        sort: { year: 'desc' },
        limit: 10,
      }),
    )
    await narsil.exportDocumentsToFile(TIMER_INDEX, EXPORT_FILE)
    const importing = await whileTicking(() => narsil.importDocumentExportFromFile(IMPORTED_INDEX, EXPORT_FILE))
    return {
      intervalMs: TIMER_INTERVAL_MS,
      documents: TIMER_DOCUMENTS,
      search: {
        workMs: search.workMs,
        ticks: search.ticks,
        longestGapMs: search.longestGapMs,
        count: search.value.count,
      },
      importing: {
        workMs: importing.workMs,
        ticks: importing.ticks,
        longestGapMs: importing.longestGapMs,
        imported: importing.value.imported,
        refusedCount: importing.value.refusedCount,
      },
    }
  } finally {
    await narsil.shutdown()
  }
}
