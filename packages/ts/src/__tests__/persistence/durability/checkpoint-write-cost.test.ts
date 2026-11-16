import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { bodyOf } from './saved-size-oracle'

const INDEX = 'letters'
const BODY_LENGTH = 300
const GROWTH_CHECKPOINTS = 64
const DOCUMENTS_PER_CHECKPOINT = 40
const GROWTH_COMPACTION_THRESHOLD = 2
const LARGEST_WRITES_PER_INSERTED_BYTE = 10
const NO_MERGE_COMPACTION_THRESHOLD = 100
const LARGE_SEGMENT_DOCUMENTS = 1_000
const SMALL_SEGMENT_DOCUMENTS = 100
const SMALL_SEGMENT_UPDATES = 90
const LARGE_SEGMENT_UPDATES = 200
const FIRST_REPLACEMENT_SEED = LARGE_SEGMENT_DOCUMENTS + SMALL_SEGMENT_DOCUMENTS
const LARGEST_REWRITE_SHARE_OF_LARGE_SEGMENT = 0.6

async function segmentFiles(directory: string): Promise<Map<string, number>> {
  const root = join(directory, INDEX, 'segments')
  const files = new Map<string, number>()
  if (!existsSync(root)) return files
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.set(path, statSync(path).size)
  }
  return files
}

function bytesOf(files: Map<string, number>): number {
  let total = 0
  for (const bytes of files.values()) total += bytes
  return total
}

function bytesWrittenBetween(before: Map<string, number>, after: Map<string, number>): number {
  let written = 0
  for (const [path, bytes] of after) if (!before.has(path)) written += bytes
  return written
}

function letterOf(id: string, seed: number): { id: string; title: string; body: string } {
  return { id, title: `letter ${seed}`, body: bodyOf(seed, BODY_LENGTH) }
}

async function expectLetters(engine: Narsil, expected: Map<string, { title: string; body: string }>): Promise<void> {
  expect(await engine.countDocuments(INDEX)).toBe(expected.size)
  for (const [id, letter] of expected) {
    expect(await engine.get(INDEX, id)).toMatchObject({ title: letter.title, body: letter.body })
  }
}

describe.each(['memory', 'disk'] as const)('the bytes that checkpoints write with text in %s', textStorage => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-checkpoint-write-cost-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  async function open(compactionThreshold: number): Promise<Narsil> {
    const opened = await createNarsil({
      durability: {
        directory,
        checkpointIntervalMs: 0,
        checkpointMutationThreshold: 1_000_000_000,
        compactionThreshold,
      },
      workers: { enabled: false },
    })
    if ((await opened.listIndexes()).every(index => index.name !== INDEX)) {
      await opened.createIndex(INDEX, {
        schema: { title: 'string', body: 'string' },
        partitions: { maxPartitions: 1 },
        textStorage,
      })
    }
    return opened
  }

  it('write each inserted byte a few times while an index grows past its compaction threshold', async () => {
    engine = await open(GROWTH_COMPACTION_THRESHOLD)
    const expected = new Map<string, { title: string; body: string }>()
    let written = 0
    let firstWritten = 0
    for (let checkpoint = 0; checkpoint < GROWTH_CHECKPOINTS; checkpoint++) {
      const batch = Array.from({ length: DOCUMENTS_PER_CHECKPOINT }, (_, at) =>
        letterOf(`letter-${checkpoint}-${at}`, checkpoint * DOCUMENTS_PER_CHECKPOINT + at),
      )
      expect((await engine.insertBatch(INDEX, batch)).failed).toEqual([])
      for (const letter of batch) expected.set(letter.id, letter)
      const before = await segmentFiles(directory)
      await engine.checkpoint(INDEX)
      written += bytesWrittenBetween(before, await segmentFiles(directory))
      if (checkpoint === 0) firstWritten = written
    }
    expect(firstWritten).toBeGreaterThan(0)
    expect(written).toBeLessThanOrEqual(firstWritten * GROWTH_CHECKPOINTS * LARGEST_WRITES_PER_INSERTED_BYTE)
    await expectLetters(engine, expected)
    await engine.shutdown()
    engine = await open(GROWTH_COMPACTION_THRESHOLD)
    await expectLetters(engine, expected)
  }, 120_000)

  it('rewrite the segment that holds the highest share of replaced documents before a larger one', async () => {
    engine = await open(NO_MERGE_COMPACTION_THRESHOLD)
    const expected = new Map<string, { title: string; body: string }>()
    const large = Array.from({ length: LARGE_SEGMENT_DOCUMENTS }, (_, at) => letterOf(`large-${at}`, at))
    expect((await engine.insertBatch(INDEX, large)).failed).toEqual([])
    await engine.checkpoint(INDEX)
    const largeBytes = bytesOf(await segmentFiles(directory))
    const small = Array.from({ length: SMALL_SEGMENT_DOCUMENTS }, (_, at) =>
      letterOf(`small-${at}`, LARGE_SEGMENT_DOCUMENTS + at),
    )
    expect((await engine.insertBatch(INDEX, small)).failed).toEqual([])
    await engine.checkpoint(INDEX)
    for (const letter of [...large, ...small]) expected.set(letter.id, letter)

    const updated = [...small.slice(0, SMALL_SEGMENT_UPDATES), ...large.slice(0, LARGE_SEGMENT_UPDATES)].map(
      (letter, at) => letterOf(letter.id, FIRST_REPLACEMENT_SEED + at),
    )
    const result = await engine.updateBatch(
      INDEX,
      updated.map(({ id, title, body }) => ({ docId: id, document: { title, body } })),
    )
    expect(result.failed).toEqual([])
    for (const letter of updated) expected.set(letter.id, letter)
    const before = await segmentFiles(directory)
    await engine.checkpoint(INDEX)
    const written = bytesWrittenBetween(before, await segmentFiles(directory))
    expect(written).toBeLessThan(largeBytes * LARGEST_REWRITE_SHARE_OF_LARGE_SEGMENT)
    await expectLetters(engine, expected)
    await engine.shutdown()
    engine = await open(NO_MERGE_COMPACTION_THRESHOLD)
    await expectLetters(engine, expected)
  }, 120_000)
})
