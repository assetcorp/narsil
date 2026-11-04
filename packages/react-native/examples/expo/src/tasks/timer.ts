import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { type CorpusDocument, corpus, queryVectors } from '../corpus'
import { announce } from '../harness'
import { type BusyProbe, startBusyProbe } from './busy-probe'
import { SEARCH_SCHEMA } from './search'

const TIMER_DIRECTORY = 'timer-check'
const TIMER_INDEX = 'timer'
const IMPORTED_INDEX = 'imported'
const TIMER_DOCUMENTS = 50_000
const IN_MEMORY_DOCUMENTS = 20_000
const TIMER_PARTITIONS = 8
const WRITE_BATCH = 2_000
const TIMER_INTERVAL_MS = 10
const IDLE_CONTROL_MS = 10_000
const RECORDED_TICK_GAP_MS = 45
const KEPT_TICK_GAPS = 6
const EXPORT_FILE = 'timer-export.ndjson'
const LONG_SEARCH = 'zorbek quilon trevac mirdel oskaro fenark borvan cindrl'
const LONG_SEARCH_TOLERANCE = 2
const UPDATED_YEAR_SHIFT = 1

export interface TickGap {
  startMs: number
  ms: number
  longestBusyMs: number
}

export interface TimedWork {
  workMs: number
  ticks: number
  longestGapMs: number
  longestBusyMs: number | null
  tickGaps: TickGap[]
}

export interface TimerOptions {
  probesAppThread: boolean
}

export interface TimerReport {
  probesAppThread: boolean
  intervalMs: number
  documents: number
  partitions: number
  idle: TimedWork
  inserting: TimedWork
  insertingInMemory: TimedWork & { documents: number }
  search: TimedWork & { count: number }
  vectorSearch: TimedWork & { count: number }
  updating: TimedWork & { updated: number }
  importing: TimedWork & { imported: number; refusedCount: number }
  removing: TimedWork & { removed: number }
}

function timedWork(work: TimedWork): TimedWork {
  return {
    workMs: work.workMs,
    ticks: work.ticks,
    longestGapMs: work.longestGapMs,
    longestBusyMs: work.longestBusyMs,
    tickGaps: work.tickGaps,
  }
}

function tickGapsOf(ticks: readonly number[], started: number, ended: number, probe: BusyProbe | null): TickGap[] {
  const gaps: TickGap[] = []
  let previous = started
  for (const tick of [...ticks, ended]) {
    const ms = tick - previous
    if (ms > RECORDED_TICK_GAP_MS) {
      const startMs = previous - started
      gaps.push({ startMs, ms, longestBusyMs: probe?.longestBusyWithin(startMs, startMs + ms) ?? Number.NaN })
    }
    previous = tick
  }
  return gaps.sort((left, right) => right.ms - left.ms).slice(0, KEPT_TICK_GAPS)
}

type Ticking = <T>(work: () => Promise<T>) => Promise<{ value: T } & TimedWork>

async function whileTicking<T>(work: () => Promise<T>, probesAppThread: boolean): Promise<{ value: T } & TimedWork> {
  const ticks: number[] = []
  const started = performance.now()
  const probe = probesAppThread ? startBusyProbe(started) : null
  const timer = setInterval(() => {
    ticks.push(performance.now())
  }, TIMER_INTERVAL_MS)
  try {
    const value = await work()
    const ended = performance.now()
    probe?.stop()
    const tickGaps = tickGapsOf(ticks, started, ended, probe)
    let longestGapMs = 0
    let previous = started
    for (const tick of [...ticks, ended]) {
      longestGapMs = Math.max(longestGapMs, tick - previous)
      previous = tick
    }
    return {
      value,
      workMs: ended - started,
      ticks: ticks.length,
      longestGapMs,
      longestBusyMs: probe?.longestBusyMs() ?? null,
      tickGaps,
    }
  } finally {
    clearInterval(timer)
    probe?.stop()
  }
}

function timerStep<T>(step: string, work: () => Promise<T>): Promise<T> {
  announce('timer-step', { started: step })
  return work()
}

function idleFor(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function fill(narsil: PhoneNarsil, documents: CorpusDocument[]): Promise<void> {
  await narsil.createIndex(TIMER_INDEX, {
    schema: SEARCH_SCHEMA,
    language: 'english',
    partitions: { maxPartitions: TIMER_PARTITIONS },
  })
  for (let start = 0; start < documents.length; start += WRITE_BATCH) {
    const batch = documents.slice(start, start + WRITE_BATCH)
    const calledAt = performance.now()
    const pending = narsil.insertBatch(TIMER_INDEX, batch)
    const returnedAt = performance.now()
    const result = await pending
    announce('timer-batch', {
      first: start,
      callMs: returnedAt - calledAt,
      settledMs: performance.now() - calledAt,
    })
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

export type CreateTimedEngine = (config: { durability: { directory: string } | null }) => Promise<PhoneNarsil>

async function openEmpty(create: CreateTimedEngine): Promise<PhoneNarsil> {
  const openedFrom = performance.now()
  const narsil = await create({ durability: { directory: TIMER_DIRECTORY } })
  const openMs = performance.now() - openedFrom
  const leftover = await narsil.listIndexes()
  announce('timer-step', {
    started: 'dropping',
    openMs,
    indexes: leftover.map(index => ({ name: index.name, documents: index.documentCount })),
  })
  for (const index of leftover) await narsil.dropIndex(index.name)
  return narsil
}

async function insertInMemory(
  create: CreateTimedEngine,
  documents: CorpusDocument[],
  ticking: Ticking,
): Promise<TimedWork> {
  const narsil = await create({ durability: null })
  try {
    return await ticking(() => fill(narsil, documents))
  } finally {
    await narsil.shutdown()
  }
}

export async function runTimerTask(
  create: CreateTimedEngine = createNarsil,
  options: Partial<TimerOptions> = {},
): Promise<TimerReport> {
  const probesAppThread = options.probesAppThread ?? true
  const ticking: Ticking = work => whileTicking(work, probesAppThread)
  const documents = corpus(TIMER_DOCUMENTS)
  const idle = await timerStep('idle', () => ticking(() => idleFor(IDLE_CONTROL_MS)))
  const insertingInMemory = await timerStep('insertingInMemory', () =>
    insertInMemory(create, documents.slice(0, IN_MEMORY_DOCUMENTS), ticking),
  )
  const narsil = await timerStep('opening', () => openEmpty(create))
  try {
    const inserting = await timerStep('inserting', () => ticking(() => fill(narsil, documents)))
    const [queryVector] = queryVectors(1)
    const vectorSearch = await timerStep('vectorSearch', () =>
      ticking(() =>
        narsil.query(TIMER_INDEX, { mode: 'vector', vector: { field: 'embedding', value: queryVector }, limit: 10 }),
      ),
    )
    const search = await timerStep('search', () =>
      ticking(() =>
        narsil.query(TIMER_INDEX, {
          term: LONG_SEARCH,
          tolerance: LONG_SEARCH_TOLERANCE,
          facets: { year: {} },
          sort: { year: 'desc' },
          limit: 10,
        }),
      ),
    )
    const updating = await timerStep('updating', () => ticking(() => update(narsil, documents)))
    await timerStep('exporting', () => narsil.exportDocumentsToFile(TIMER_INDEX, EXPORT_FILE))
    const importing = await timerStep('importing', () =>
      ticking(() => narsil.importDocumentExportFromFile(IMPORTED_INDEX, EXPORT_FILE)),
    )
    const removing = await timerStep('removing', () => ticking(() => remove(narsil, documents)))
    return {
      probesAppThread,
      intervalMs: TIMER_INTERVAL_MS,
      documents: TIMER_DOCUMENTS,
      partitions: TIMER_PARTITIONS,
      idle: timedWork(idle),
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
    await timerStep('closing', () => narsil.shutdown())
  }
}
