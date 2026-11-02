import { createNarsil, isNarsilError, type PhoneNarsil } from '@delali/narsil-react-native'
import { Directory, type File, Paths } from 'expo-file-system'
import { corpus, DIMENSION, HYBRID_TERM, seededRandom } from '../corpus'
import { announce } from '../harness'
import { SEARCH_SCHEMA } from './search'

const DAMAGED_INDEX = 'damaged'
const DAMAGED_DOCUMENTS = 2_000
const SNAPSHOT_DOCUMENTS = 500
const SEGMENT_DIRECTORY = 'segments'
const FILE_URI_PREFIX = 'file://'
const GROWTH_INDEX = 'growth'
const GROWTH_DIMENSION = 1_536
const GROWTH_BATCH = 256
const GROWTH_SEED = 0x6e0_57a7
const GROWTH_PROMOTION_THRESHOLD = 100_000_000
const GROWTH_MOST_BATCHES = 20_000
const GROWTH_PROGRESS_EVERY_BATCHES = 50

export interface RaisedError {
  raised: boolean
  typed: boolean
  name: string | null
  code: string | null
  message: string | null
  details: unknown
}

export interface MemoryLimitProgress {
  documentsAccepted: number
  batches: number
  elapsedMs: number
}

export interface ErrorsSteps {
  damagedCheckpoint: { truncatedFiles: Array<{ name: string; bytes: number; keptBytes: number }>; error: RaisedError }
  damagedSnapshot: { truncated: RaisedError; flipped: RaisedError }
  invalidVectors: { wrongDimension: RaisedError; notANumber: RaisedError; notAVector: RaisedError }
  memoryLimit: MemoryLimitProgress & { error: RaisedError; memoryAfter: unknown; searchAfterBlock: number }
  appStillAnswers: boolean
}

export interface ErrorsReport extends Partial<ErrorsSteps> {
  memoryLimitProgress: MemoryLimitProgress | null
  stepFailures: Array<{ step: keyof ErrorsSteps; error: RaisedError }>
}

function describedError(error: unknown): RaisedError {
  const typed = isNarsilError(error)
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    code?: unknown
    message?: unknown
    details?: unknown
  }
  return {
    raised: true,
    typed,
    name: typeof record.name === 'string' ? record.name : null,
    code: typeof record.code === 'string' ? record.code : null,
    message: typeof record.message === 'string' ? record.message : String(error),
    details: typed ? record.details : null,
  }
}

async function raisedBy(work: () => Promise<unknown>): Promise<RaisedError> {
  try {
    await work()
    return { raised: false, typed: false, name: null, code: null, message: null, details: null }
  } catch (error) {
    return describedError(error)
  }
}

function pathOf(uri: string): string {
  return decodeURI(uri.startsWith(FILE_URI_PREFIX) ? uri.slice(FILE_URI_PREFIX.length) : uri)
}

function segmentFilesUnder(directory: Directory, insideSegments: boolean): File[] {
  const found: File[] = []
  for (const entry of directory.list()) {
    if (entry instanceof Directory) {
      found.push(...segmentFilesUnder(entry, insideSegments || entry.name === SEGMENT_DIRECTORY))
    } else if (insideSegments) {
      found.push(entry)
    }
  }
  return found
}

async function cutCheckpointShort(): Promise<ErrorsSteps['damagedCheckpoint']> {
  const directory = new Directory(Paths.document, `narsil-damaged-${Date.now()}`)
  directory.create()
  const durability = { directory: pathOf(directory.uri) }
  try {
    const writer = await createNarsil({ durability })
    try {
      await writer.createIndex(DAMAGED_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
      const inserted = await writer.insertBatch(DAMAGED_INDEX, corpus(DAMAGED_DOCUMENTS))
      if (inserted.failed.length > 0) throw new Error(`${inserted.failed.length} documents failed to insert`)
      await writer.checkpoint(DAMAGED_INDEX)
    } finally {
      await writer.shutdown()
    }

    const files = segmentFilesUnder(directory, false)
    if (files.length === 0) throw new Error('The checkpoint wrote no segment files to cut short')
    const truncatedFiles: ErrorsSteps['damagedCheckpoint']['truncatedFiles'] = []
    for (const file of files) {
      const bytes = await file.bytes()
      const keptBytes = Math.floor(bytes.byteLength / 2)
      await file.write(bytes.slice(0, keptBytes))
      truncatedFiles.push({ name: file.name, bytes: bytes.byteLength, keptBytes })
    }

    const opened: { reader: PhoneNarsil | null } = { reader: null }
    const error = await raisedBy(async () => {
      const reader = await createNarsil({ durability })
      opened.reader = reader
      await reader.query(DAMAGED_INDEX, { term: HYBRID_TERM, limit: 10 })
      await reader.countDocuments(DAMAGED_INDEX)
    })
    await opened.reader?.shutdown().catch(() => undefined)
    return { truncatedFiles, error }
  } finally {
    if (directory.exists) directory.delete()
  }
}

async function damageSnapshots(): Promise<ErrorsSteps['damagedSnapshot']> {
  const narsil = await createNarsil({ durability: null })
  try {
    await narsil.createIndex(DAMAGED_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    await narsil.insertBatch(DAMAGED_INDEX, corpus(SNAPSHOT_DOCUMENTS))
    const snapshot = await narsil.snapshot(DAMAGED_INDEX)
    const truncated = await raisedBy(() =>
      narsil.restore('cut-short', snapshot.slice(0, Math.floor(snapshot.byteLength / 2))),
    )
    const flippedBytes = snapshot.slice()
    const middle = Math.floor(flippedBytes.byteLength / 2)
    flippedBytes[middle] = (flippedBytes[middle] ?? 0) ^ 0xff
    const flipped = await raisedBy(() => narsil.restore('flipped', flippedBytes))
    return { truncated, flipped }
  } finally {
    await narsil.shutdown()
  }
}

async function insertInvalidVectors(): Promise<ErrorsSteps['invalidVectors']> {
  const narsil = await createNarsil({ durability: null })
  try {
    await narsil.createIndex(DAMAGED_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    const base = { title: 'zorbex quillon', year: 2000 }
    const wrongDimension = await raisedBy(() =>
      narsil.insert(DAMAGED_INDEX, { ...base, embedding: new Array(DIMENSION + 1).fill(0.5) }, 'wrong-dimension'),
    )
    const notANumber = await raisedBy(() =>
      narsil.insert(
        DAMAGED_INDEX,
        { ...base, embedding: Array.from({ length: DIMENSION }, (_, i) => (i === 0 ? Number.NaN : 0.5)) },
        'not-a-number',
      ),
    )
    const notAVector = await raisedBy(() =>
      narsil.insert(DAMAGED_INDEX, { ...base, embedding: 'a vector in words' }, 'not-a-vector'),
    )
    return { wrongDimension, notANumber, notAVector }
  } finally {
    await narsil.shutdown()
  }
}

function growthBatch(random: () => number, firstId: number): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let offset = 0; offset < GROWTH_BATCH; offset++) {
    const embedding = new Float32Array(GROWTH_DIMENSION)
    for (let component = 0; component < GROWTH_DIMENSION; component++) embedding[component] = random() * 2 - 1
    documents.push({ id: `g-${firstId + offset}`, title: 'zorbex', embedding })
  }
  return documents
}

async function growPastMemoryLimit(progress: MemoryLimitProgress): Promise<ErrorsSteps['memoryLimit']> {
  const narsil = await createNarsil({ durability: null })
  const random = seededRandom(GROWTH_SEED)
  const started = performance.now()
  let documentsAccepted = 0
  let batches = 0
  const noteProgress = () => {
    progress.documentsAccepted = documentsAccepted
    progress.batches = batches
    progress.elapsedMs = performance.now() - started
  }
  try {
    await narsil.createIndex(GROWTH_INDEX, {
      schema: { title: 'string', embedding: `vector[${GROWTH_DIMENSION}]` },
      language: 'english',
      vectorPromotion: { threshold: GROWTH_PROMOTION_THRESHOLD, quantization: 'none' },
    })
    const error = await raisedBy(async () => {
      while (batches < GROWTH_MOST_BATCHES) {
        const result = await narsil.insertBatch(GROWTH_INDEX, growthBatch(random, documentsAccepted))
        batches++
        documentsAccepted += result.succeeded.length
        noteProgress()
        const refusal = result.failed[0]
        if (refusal !== undefined) throw refusal.error
        if (batches % GROWTH_PROGRESS_EVERY_BATCHES === 0) announce('memory-growth', { batches, documentsAccepted })
      }
    })
    const elapsedMs = performance.now() - started
    const memoryAfter = await narsil.getMemoryStats()
    const searchAfterBlock = (await narsil.query(GROWTH_INDEX, { term: 'zorbex', limit: 1 })).count
    return { error, documentsAccepted, batches, elapsedMs, memoryAfter, searchAfterBlock }
  } finally {
    await narsil.dropIndex(GROWTH_INDEX).catch(() => undefined)
    await narsil.shutdown()
  }
}

async function answersAfterwards(): Promise<boolean> {
  const narsil = await createNarsil({ durability: null })
  try {
    await narsil.createIndex(DAMAGED_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    await narsil.insertBatch(DAMAGED_INDEX, corpus(SNAPSHOT_DOCUMENTS))
    return (await narsil.countDocuments(DAMAGED_INDEX)) === SNAPSHOT_DOCUMENTS
  } finally {
    await narsil.shutdown()
  }
}

async function recordStep<K extends keyof ErrorsSteps>(
  report: ErrorsReport,
  step: K,
  work: () => Promise<ErrorsSteps[K]>,
): Promise<void> {
  try {
    Object.assign(report, { [step]: await work() })
    announce('errors-step', { finished: step })
  } catch (error) {
    const described = describedError(error)
    report.stepFailures.push({ step, error: described })
    announce('errors-step', { failed: step, code: described.code, message: described.message })
  }
}

export async function runErrorsTask(): Promise<ErrorsReport> {
  const progress: MemoryLimitProgress = { documentsAccepted: 0, batches: 0, elapsedMs: 0 }
  const report: ErrorsReport = { memoryLimitProgress: progress, stepFailures: [] }
  await recordStep(report, 'damagedCheckpoint', cutCheckpointShort)
  await recordStep(report, 'damagedSnapshot', damageSnapshots)
  await recordStep(report, 'invalidVectors', insertInvalidVectors)
  await recordStep(report, 'memoryLimit', () => growPastMemoryLimit(progress))
  await recordStep(report, 'appStillAnswers', answersAfterwards)
  return report
}
