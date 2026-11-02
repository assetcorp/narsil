import { chmod, mkdtemp, open as openFile, readdir, rm, stat, truncate, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { ArticleOracle, randomArticle, seededRandom, VOCABULARY } from './oracle'

const INDEX = 'articles'
const DOCUMENTS = 3_000
const SPEC_ERRORS: readonly string[] = [ErrorCodes.PERSISTENCE_CRC_MISMATCH, ErrorCodes.PERSISTENCE_LOAD_FAILED]
const PAGE_BYTES = 65_536

const ARTICLE_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
  textStorage: 'disk',
}

async function segmentFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const paths = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return paths.filter(path => /\/segments\/\d+\/s\d+$/.test(path)).sort()
}

async function flipByte(path: string, offset: number): Promise<void> {
  const handle = await openFile(path, 'r+')
  try {
    const one = new Uint8Array(1)
    await handle.read(one, 0, 1, offset)
    one[0] ^= 0x5a
    await handle.write(one, 0, 1, offset)
  } finally {
    await handle.close()
  }
}

type Outcome = { answered: true; matches: boolean } | { answered: false; code: string }

async function readEverything(root: string, oracle: ArticleOracle): Promise<Outcome> {
  let engine: Narsil | null = null
  try {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    let matches = true
    for (const word of VOCABULARY) {
      const result = await engine.query(INDEX, { term: word, limit: DOCUMENTS })
      const ids = result.hits.map(hit => hit.id).sort()
      matches &&= JSON.stringify(ids) === JSON.stringify(oracle.idsHolding(word))
    }
    for (const [id, document] of oracle.documents) {
      const stored = await engine.get(INDEX, id)
      matches &&= JSON.stringify(stored) === JSON.stringify({ id, ...document })
    }
    return { answered: true, matches }
  } catch (error) {
    return { answered: false, code: String((error as { code?: unknown }).code) }
  } finally {
    await engine?.shutdown().catch(() => undefined)
  }
}

describe('damaged files of an index with its text on disk', () => {
  let root: string
  let oracle: ArticleOracle

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-damage-'))
    oracle = new ArticleOracle()
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await engine.createIndex(INDEX, ARTICLE_CONFIG)
    const random = seededRandom(95)
    const batch = []
    for (let i = 0; i < DOCUMENTS; i++) {
      const document = randomArticle(random)
      oracle.set(`article-${i}`, document)
      batch.push({ id: `article-${i}`, ...document })
    }
    await engine.insertBatch(INDEX, batch)
    await engine.checkpoint(INDEX)
    await engine.shutdown()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('raises a load failure for a truncated segment file', async () => {
    const [segment] = await segmentFiles(root)
    const { size } = await stat(segment)
    await truncate(segment, size - 100)
    expect(await readEverything(root, oracle)).toEqual({ answered: false, code: ErrorCodes.PERSISTENCE_LOAD_FAILED })
  })

  it('gives the right answers or a damage error for a byte changed anywhere in a segment file', async () => {
    const [segment] = await segmentFiles(root)
    const { size } = await stat(segment)
    let raised = 0
    const stride = Math.max(1, Math.floor(size / 12))
    for (let offset = 64; offset < size; offset += stride) {
      await flipByte(segment, offset)
      const outcome = await readEverything(root, oracle)
      await flipByte(segment, offset)
      if (outcome.answered) {
        expect(outcome.matches, `a byte changed at ${offset} of ${size}`).toBe(true)
      } else {
        expect(SPEC_ERRORS, `a byte changed at ${offset} of ${size}`).toContain(outcome.code)
        raised += 1
      }
    }
    expect(raised).toBeGreaterThan(0)
  }, 180_000)

  it('raises a damage error for a segment file cut back to its first page', async () => {
    const [segment] = await segmentFiles(root)
    await truncate(segment, Math.min(PAGE_BYTES, (await stat(segment)).size - 1))
    const outcome = await readEverything(root, oracle)
    expect(outcome.answered).toBe(false)
    if (!outcome.answered) expect(SPEC_ERRORS).toContain(outcome.code)
  })

  it('raises a load failure for a segment file that disappears', async () => {
    const [segment] = await segmentFiles(root)
    await unlink(segment)
    const outcome = await readEverything(root, oracle)
    expect(outcome.answered).toBe(false)
    if (!outcome.answered) expect(SPEC_ERRORS).toContain(outcome.code)
  })

  it('raises a damage error for a segment file that this process cannot read', async () => {
    const [segment] = await segmentFiles(root)
    if (process.getuid?.() === 0) return
    await chmod(segment, 0)
    try {
      const outcome = await readEverything(root, oracle)
      expect(outcome.answered).toBe(false)
      if (!outcome.answered) expect(SPEC_ERRORS).toContain(outcome.code)
    } finally {
      await chmod(segment, 0o644)
    }
  })

  it('keeps answering from a file deleted after its index opened, because the handle stays valid', async () => {
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    try {
      const word = VOCABULARY[0]
      const before = await engine.query(INDEX, { term: word, limit: DOCUMENTS })
      for (const segment of await segmentFiles(root)) await unlink(segment)
      const later = VOCABULARY[1]
      const answer = await engine.query(INDEX, { term: later, limit: DOCUMENTS })
      expect(before.hits.map(hit => hit.id).sort()).toEqual(oracle.idsHolding(word))
      expect(answer.hits.map(hit => hit.id).sort()).toEqual(oracle.idsHolding(later))
    } finally {
      await engine.shutdown()
    }
  })
})

describe('the storage settings of an index with its text on disk', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-settings-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses text on disk on an engine without filesystem durability', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      await expect(engine.createIndex(INDEX, ARTICLE_CONFIG)).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    } finally {
      await engine.shutdown()
    }
  })

  it('refuses a snapshot whose configuration sets disk on an engine without filesystem durability', async () => {
    const source = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await source.createIndex(INDEX, ARTICLE_CONFIG)
    await source.insert(INDEX, { title: 'amber', body: 'basil', year: 2000 }, 'only')
    await source.checkpoint(INDEX)
    const stream = await source.snapshot(INDEX)
    const archive = new Uint8Array(await new Response(stream).arrayBuffer())
    await source.shutdown()
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      await expect(engine.restore(INDEX, archive)).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    } finally {
      await engine.shutdown()
    }
  })

  it('refuses a storage mode that it does not know', async () => {
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    try {
      const config = { ...ARTICLE_CONFIG, textStorage: 'tape' } as unknown as IndexConfig
      await expect(engine.createIndex(INDEX, config)).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    } finally {
      await engine.shutdown()
    }
  })

  it('counts only the memory that an index uses against the limit on open indexes', async () => {
    const random = seededRandom(5)
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `article-${i}`, ...randomArticle(random) }))

    const memoryRoot = await mkdtemp(join(tmpdir(), 'narsil-disk-limit-'))
    const measuring = await createNarsil({ durability: { directory: memoryRoot }, workers: { enabled: false } })
    await measuring.createIndex('in-memory', { ...ARTICLE_CONFIG, textStorage: 'memory' })
    await measuring.insertBatch('in-memory', documents)
    await measuring.checkpoint('in-memory')
    const memoryBytes = measuring.getPartitionStats('in-memory')[0].estimatedMemoryBytes
    await measuring.shutdown()
    await rm(memoryRoot, { recursive: true, force: true })

    const limit = Math.floor(memoryBytes * 1.5)
    const engine = await createNarsil({
      durability: { directory: root },
      workers: { enabled: false },
      lifecycle: { maxOpenBytes: limit },
    })
    try {
      for (const name of ['first', 'second', 'third']) {
        await engine.createIndex(name, ARTICLE_CONFIG)
        await engine.insertBatch(name, documents)
        await engine.checkpoint(name)
      }
      const diskBytes = engine.getPartitionStats('third')[0].estimatedMemoryBytes
      expect(diskBytes).toBeLessThan(memoryBytes / 2)
      for (const name of ['first', 'second', 'third']) {
        const result = await engine.query(name, { term: VOCABULARY[0], limit: 1 })
        expect(result.count).toBeGreaterThan(0)
      }
      expect(engine.listIndexes().every(index => index.state === 'open')).toBe(true)
    } finally {
      await engine.shutdown()
    }
  }, 120_000)
})
