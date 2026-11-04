import { createNarsil, isNarsilError, type PhoneNarsil } from '@delali/narsil-react-native/worklets'
import { type CorpusDocument, corpus } from '../../expo/src/corpus'
import { announce } from '../../expo/src/harness'
import { SEARCH_SCHEMA } from '../../expo/src/tasks/search'

const SETUP_REFUSAL = 'The setup worklet refused to start this engine'
const HOSTILE_INDEX = 'hostile'
const NOT_A_LIST_INDEX = 'not-a-list'
const AFTERWARDS_INDEX = 'afterwards'
const MISSING_INDEX = 'never-created'
const HOSTILE_BATCH = 3_000
const BAD_DOCUMENT_EVERY = 97
const AFTERWARDS_DOCUMENTS = 2_000
const ANSWER_WITHIN_MS = 120_000

export interface CallAnswer {
  settled: boolean
  raised: boolean
  typed: boolean
  name: string | null
  code: string | null
  message: string | null
}

export interface HostileBatch {
  sent: number
  badDocuments: number
  answer: CallAnswer
  succeeded: number | null
  failed: number | null
  storedAfterwards: number | null
}

export interface EngineErrorsReport {
  setupThrows: CallAnswer
  batchNotAList: CallAnswer
  missingIndex: CallAnswer
  hostileBatch: HostileBatch
  answersAfterwards: { stored: number | null; matched: number | null; answer: CallAnswer }
}

function answerOf(error: unknown): CallAnswer {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  return {
    settled: true,
    raised: true,
    typed: isNarsilError(error),
    name: typeof record.name === 'string' ? record.name : null,
    code: typeof record.code === 'string' ? record.code : null,
    message: typeof record.message === 'string' ? record.message : String(error),
  }
}

const RESOLVED: CallAnswer = { settled: true, raised: false, typed: false, name: null, code: null, message: null }
const UNANSWERED: CallAnswer = { settled: false, raised: false, typed: false, name: null, code: null, message: null }

async function answered<T>(work: () => Promise<T>): Promise<{ answer: CallAnswer; value: T | null }> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const unanswered = new Promise<{ answer: CallAnswer; value: T | null }>(resolve => {
    timer = setTimeout(() => resolve({ answer: UNANSWERED, value: null }), ANSWER_WITHIN_MS)
  })
  const settled = work().then(
    value => ({ answer: RESOLVED, value }),
    (error: unknown) => ({ answer: answerOf(error), value: null }),
  )
  try {
    return await Promise.race([settled, unanswered])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function refusingSetup(): never {
  'worklet'
  throw new Error(SETUP_REFUSAL)
}

async function openWithThrowingSetup(): Promise<CallAnswer> {
  const { answer, value } = await answered(() => createNarsil({ durability: null }, refusingSetup))
  await value?.shutdown().catch(() => undefined)
  return answer
}

function badDocument(document: CorpusDocument, position: number): unknown {
  switch (position % 3) {
    case 0:
      return null
    case 1:
      return { ...document, embedding: 'a vector in words' }
    default:
      return { ...document, year: 'the year after next' }
  }
}

function hostileDocuments(): { documents: unknown[]; badDocuments: number } {
  const documents: unknown[] = []
  let badDocuments = 0
  for (const [index, document] of corpus(HOSTILE_BATCH).entries()) {
    if (index % BAD_DOCUMENT_EVERY === BAD_DOCUMENT_EVERY - 1) {
      documents.push(badDocument(document, badDocuments))
      badDocuments++
    } else {
      documents.push(document)
    }
  }
  return { documents, badDocuments }
}

async function insertHostileBatch(narsil: PhoneNarsil): Promise<HostileBatch> {
  await narsil.createIndex(HOSTILE_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
  const { documents, badDocuments } = hostileDocuments()
  const { answer, value } = await answered(() =>
    narsil.insertBatch(HOSTILE_INDEX, documents as Array<Record<string, unknown>>),
  )
  const stored = await answered(() => narsil.countDocuments(HOSTILE_INDEX))
  return {
    sent: documents.length,
    badDocuments,
    answer,
    succeeded: value?.succeeded.length ?? null,
    failed: value?.failed.length ?? null,
    storedAfterwards: stored.value,
  }
}

async function answerAfterwards(narsil: PhoneNarsil): Promise<EngineErrorsReport['answersAfterwards']> {
  await narsil.createIndex(AFTERWARDS_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
  const documents = corpus(AFTERWARDS_DOCUMENTS)
  const { answer } = await answered(() => narsil.insertBatch(AFTERWARDS_INDEX, documents))
  const stored = await answered(() => narsil.countDocuments(AFTERWARDS_INDEX))
  const first = documents[0]
  const matched =
    first === undefined
      ? null
      : ((await answered(() => narsil.query(AFTERWARDS_INDEX, { term: first.title, limit: AFTERWARDS_DOCUMENTS })))
          .value?.count ?? null)
  return { stored: stored.value, matched, answer }
}

export async function runEngineErrorsTask(): Promise<EngineErrorsReport> {
  const setupThrows = await openWithThrowingSetup()
  announce('engine-errors-step', { finished: 'setupThrows' })
  const narsil = await createNarsil({ durability: null })
  try {
    await narsil.createIndex(NOT_A_LIST_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    const batchNotAList = (await answered(() => narsil.insertBatch(NOT_A_LIST_INDEX, 'not a list' as unknown as [])))
      .answer
    const missingIndex = (await answered(() => narsil.query(MISSING_INDEX, { term: 'zorbex', limit: 1 }))).answer
    announce('engine-errors-step', { finished: 'malformedCalls' })
    const hostileBatch = await insertHostileBatch(narsil)
    announce('engine-errors-step', { finished: 'hostileBatch' })
    const answersAfterwards = await answerAfterwards(narsil)
    return { setupThrows, batchNotAList, missingIndex, hostileBatch, answersAfterwards }
  } finally {
    await narsil.shutdown().catch(() => undefined)
  }
}
