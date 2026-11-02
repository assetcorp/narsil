import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { type CorpusDocument, corpus, DIMENSION } from '../corpus'
import { acknowledge, announce } from '../harness'

export const DURABLE_INDEX = 'durable'
const DURABLE_SCHEMA = { title: 'string', year: 'number', embedding: `vector[${DIMENSION}]` } as const
const SOURCE_DOCUMENTS = 2_000
const LIST_PAGE = 1_000
const CHECKPOINT_BATCH = 2_000

export function writtenId(sequence: number): string {
  return `w-${String(sequence).padStart(8, '0')}`
}

async function openDurable(directory: string): Promise<PhoneNarsil> {
  const narsil = await createNarsil({ durability: { directory } })
  const indexes = await narsil.listIndexes()
  if (!indexes.some(index => index.name === DURABLE_INDEX)) {
    await narsil.createIndex(DURABLE_INDEX, { schema: DURABLE_SCHEMA, language: 'english' })
  }
  return narsil
}

function writtenDocument(source: readonly CorpusDocument[], sequence: number): CorpusDocument {
  const template = source[sequence % source.length]
  if (template === undefined) throw new Error('The source corpus is empty')
  return { id: writtenId(sequence), title: template.title, year: template.year, embedding: template.embedding }
}

export async function writeUntilEnded(directory: string, firstId: number): Promise<never> {
  const narsil = await openDurable(directory)
  const source = corpus(SOURCE_DOCUMENTS)
  announce('writing', { directory, firstId })
  for (let sequence = firstId; ; sequence++) {
    const { id, ...document } = writtenDocument(source, sequence)
    await narsil.insert(DURABLE_INDEX, document, id)
    acknowledge([id])
  }
}

export async function checkpointUntilEnded(directory: string, firstId: number): Promise<never> {
  const narsil = await openDurable(directory)
  const source = corpus(SOURCE_DOCUMENTS)
  announce('writing', { directory, firstId })
  for (let sequence = firstId; ; sequence += CHECKPOINT_BATCH) {
    const batch = Array.from({ length: CHECKPOINT_BATCH }, (_, offset) => writtenDocument(source, sequence + offset))
    const result = await narsil.insertBatch(DURABLE_INDEX, batch)
    if (result.failed.length > 0) throw new Error(`${result.failed.length} documents failed to insert`)
    acknowledge(result.succeeded)
    announce('checkpoint-started', { sequence })
    await narsil.checkpoint(DURABLE_INDEX)
    announce('checkpoint-finished', { sequence })
  }
}

export async function storedIds(directory: string): Promise<{ ids: string[]; openMs: number }> {
  const started = performance.now()
  const narsil = await openDurable(directory)
  const openMs = performance.now() - started
  try {
    const ids: string[] = []
    let cursor: string | null | undefined
    do {
      const page = await narsil.listDocuments(DURABLE_INDEX, {
        cursor: cursor ?? undefined,
        limit: LIST_PAGE,
        document: { exclude: ['embedding'] },
      })
      for (const entry of page.documents) ids.push(entry.id)
      cursor = page.cursor
    } while (cursor !== null && cursor !== undefined)
    return { ids, openMs }
  } finally {
    await narsil.shutdown()
  }
}
