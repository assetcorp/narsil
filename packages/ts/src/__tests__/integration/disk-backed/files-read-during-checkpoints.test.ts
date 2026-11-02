import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { LOG_RECORDS_PER_CHECKPOINT } from '../../../persistence/durability/constants'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { ArticleOracle, randomArticle, seededRandom, VOCABULARY } from './oracle'

const INDEX = 'articles'
const SEGMENTS_BEFORE_A_MERGE = 3
const MUTATIONS_THAT_NEVER_TRIGGER_A_CHECKPOINT = 100_000_000
const INTERVAL_THAT_NEVER_TRIGGERS_A_CHECKPOINT_MS = 3_600_000
const FILLER_WORD = 'zircon'
const FILLER_BATCH = 5_000
const FILLER_DOCUMENTS = LOG_RECORDS_PER_CHECKPOINT + 50

const CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
  textStorage: 'disk',
  partitions: { maxPartitions: 1 },
}

async function segmentFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const paths = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return paths.filter(path => /\/segments\/\d+\/s\d+$/.test(path)).sort()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('a checkpoint that merges the files of an index with its text on disk', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<void> {
    engine = await createNarsil({
      durability: {
        directory: root,
        compactionThreshold: SEGMENTS_BEFORE_A_MERGE,
        checkpointMutationThreshold: MUTATIONS_THAT_NEVER_TRIGGER_A_CHECKPOINT,
        checkpointIntervalMs: INTERVAL_THAT_NEVER_TRIGGERS_A_CHECKPOINT_MS,
      },
      workers: { enabled: false },
    })
  }

  async function expectWordMatches(word: string, oracle: ArticleOracle): Promise<void> {
    const page = await engine.query(INDEX, { term: word, limit: oracle.documents.size + 10 })
    expect(page.hits.map(hit => hit.id).sort()).toEqual(oracle.idsHolding(word))
  }

  async function expectOracleDocuments(oracle: ArticleOracle): Promise<void> {
    for (const word of VOCABULARY) await expectWordMatches(word, oracle)
    for (const [id, document] of oracle.documents) expect(await engine.get(INDEX, id)).toEqual(document)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-merge-'))
    await open()
    await engine.createIndex(INDEX, CONFIG)
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps every file that a search can read until the engine reads the merged file', async () => {
    const random = seededRandom(9501)
    const oracle = new ArticleOracle()
    for (let round = 0; round < SEGMENTS_BEFORE_A_MERGE; round++) {
      for (let at = 0; at < 200; at++) {
        const document = randomArticle(random)
        await engine.insert(INDEX, document, `article-${round}-${at}`)
        oracle.set(`article-${round}-${at}`, document)
      }
      await engine.checkpoint(INDEX)
    }
    await engine.shutdown()
    await open()

    const filesBeforeTheMerge = await segmentFiles(root)
    expect(filesBeforeTheMerge.length).toBe(SEGMENTS_BEFORE_A_MERGE)

    for (let at = 0; at < FILLER_DOCUMENTS; at += FILLER_BATCH) {
      const batch = []
      for (let offset = at; offset < Math.min(at + FILLER_BATCH, FILLER_DOCUMENTS); offset++) {
        batch.push({ id: `filler-${offset}`, title: FILLER_WORD, body: FILLER_WORD, year: 1990 })
      }
      const result = await engine.insertBatch(INDEX, batch)
      expect(result.failed).toEqual([])
    }

    let checkpointFinished = false
    const checkpoint = engine.checkpoint(INDEX).finally(() => {
      checkpointFinished = true
    })
    let wordAt = 0
    while (!checkpointFinished) {
      await expectWordMatches(VOCABULARY[wordAt % VOCABULARY.length], oracle)
      wordAt += 1
      await new Promise(resolve => setImmediate(resolve))
    }
    await checkpoint

    for (const path of filesBeforeTheMerge) expect(await exists(path), path).toBe(true)
    await expectOracleDocuments(oracle)
    expect(await engine.countDocuments(INDEX)).toBe(oracle.documents.size + FILLER_DOCUMENTS)

    await engine.insert(INDEX, { title: FILLER_WORD, body: FILLER_WORD, year: 1990 }, 'after-the-merge')
    await engine.checkpoint(INDEX)
    const filesAfterTheNextCheckpoint = new Set(await segmentFiles(root))
    for (const path of filesBeforeTheMerge) expect(filesAfterTheNextCheckpoint.has(path), path).toBe(false)
    await expectOracleDocuments(oracle)

    await engine.shutdown()
    await open()
    await expectOracleDocuments(oracle)
    expect(await engine.countDocuments(INDEX)).toBe(oracle.documents.size + FILLER_DOCUMENTS + 1)
  }, 180_000)
})
