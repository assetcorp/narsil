import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { AnalysisChange } from '../../../types/analysis-operations'
import { foldOracle, generatedDocuments, idsWithWord, YORUBA_WORDS } from './oracle'

const CORPUS_SIZE = 90
const CORPUS_SEED = 11
const EVERY_HIT = 1_000
const QUERY = 'oko'
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)
const later = [
  { id: 'later-marked', body: 'ọkọ̀ ìwé' },
  { id: 'later-plain', body: 'oko ile' },
]
const folded = (docs: typeof documents) => idsWithWord(docs, word => foldOracle(word) === QUERY)
const written = (docs: typeof documents) => idsWithWord(docs, word => word === QUERY)

async function hitIds(narsil: Narsil): Promise<string[]> {
  const result = await narsil.query('words', { term: QUERY, limit: EVERY_HIT })
  return result.hits.map(hit => hit.id).sort()
}

describe('the foldMarks setting of an index', () => {
  let directory: string
  let narsil: Narsil | null = null

  const open = async (): Promise<Narsil> => {
    narsil = await createNarsil({ workers: { enabled: false }, durability: { directory, mode: 'sync' } })
    return narsil
  }

  beforeEach(async () => {
    registerLanguage(yoruba)
    resetCheckpointWorkerLatch()
    directory = await mkdtemp(join(tmpdir(), 'narsil-fold-marks-'))
  })

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = null
    await rm(directory, { recursive: true, force: true })
  })

  it('switches folding off and back on without a rebuild, and keeps each setting across restarts', async () => {
    let engine = await open()
    await engine.createIndex('words', {
      schema: { body: 'string' },
      language: 'yoruba',
      partitions: { maxPartitions: 2 },
    })
    await engine.insertBatch('words', documents)
    await engine.rebalance('words', 2)
    expect(written(documents)).not.toEqual(folded(documents))
    expect(await hitIds(engine)).toEqual(folded(documents))

    await engine.changeAnalysis('words', { foldMarks: false })
    expect(await hitIds(engine)).toEqual(written(documents))
    await engine.shutdown()

    engine = await open()
    expect(await hitIds(engine)).toEqual(written(documents))
    await engine.changeAnalysis('words', { foldMarks: null })
    expect(await hitIds(engine)).toEqual(folded(documents))
    await engine.insertBatch('words', later)
    await engine.shutdown()

    engine = await open()
    expect(await hitIds(engine)).toEqual(folded([...documents, ...later]))
  })

  it('keeps foldMarks through a snapshot that another engine restores', async () => {
    const engine = await open()
    await engine.createIndex('words', { schema: { body: 'string' }, language: 'yoruba', foldMarks: false })
    await engine.insertBatch('words', documents)
    const copy = await createNarsil({ workers: { enabled: false } })
    try {
      await copy.restore('words', await engine.snapshot('words'))
      expect(await hitIds(copy)).toEqual(written(documents))
      await copy.changeAnalysis('words', { foldMarks: true })
      expect(await hitIds(copy)).toEqual(folded(documents))
    } finally {
      await copy.shutdown()
    }
  })

  it('refuses a foldMarks value that is not a boolean or null', async () => {
    const engine = await open()
    await engine.createIndex('words', { schema: { body: 'string' }, language: 'yoruba' })
    await engine.insertBatch('words', documents)
    for (const value of ['yes', 1, {}, []]) {
      const change = { foldMarks: value } as unknown as AnalysisChange
      await expect(engine.changeAnalysis('words', change)).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
      await expect(
        engine.createIndex('other', { schema: { body: 'string' }, language: 'yoruba', foldMarks: value as boolean }),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    }
    expect(await hitIds(engine)).toEqual(folded(documents))
  })
})
