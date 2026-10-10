import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FieldFilter } from '../../types/filters'
import { listedIds, PATTERN_INDEX, patternConfig, patternDocuments, referenceIds } from '../filters/pattern/fixtures'

const PROBES: Array<[string, FieldFilter]> = [
  ['code', { contains: 'inv', caseFold: true }],
  ['code', { eq: 'strasse', caseFold: true }],
  ['title', { contains: 'error', caseFold: true }],
  ['tags', { ne: 'beta' }],
  ['tags', { in: ['ab', 'gamma'] }],
]

async function expectReferenceResults(narsil: Narsil): Promise<void> {
  const documents = patternDocuments()
  for (const [field, filter] of PROBES) {
    expect(await listedIds(narsil, field, filter)).toEqual(referenceIds(documents, field, filter))
  }
}

describe('a pattern field after durability recovery', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-pattern-recovery-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns the same documents after the engine replays its write-ahead log', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex(PATTERN_INDEX, patternConfig)
    await writer.insertBatch(PATTERN_INDEX, patternDocuments())
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await expectReferenceResults(reader)
    await reader.shutdown()
  })

  it('returns the same documents after recovery from a checkpoint', async () => {
    const documents = patternDocuments()
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex(PATTERN_INDEX, patternConfig)
    await writer.insertBatch(PATTERN_INDEX, documents.slice(0, 10))
    await writer.checkpoint(PATTERN_INDEX)
    await writer.insertBatch(PATTERN_INDEX, documents.slice(10))
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await expectReferenceResults(reader)
    await reader.shutdown()
  })
})
