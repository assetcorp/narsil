import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { CustomTokenizer } from '../../../types/schema'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'

const CODE_UNITS_PER_TOKEN = 2
const TOKENIZER_NAME = 'two-code-units'
const SEGMENT_EVERY_WRITE = 1

function open(directory: string): Promise<Narsil> {
  return createNarsil({
    durability: { directory, compactionThreshold: SEGMENT_EVERY_WRITE },
    workers: { enabled: false },
  })
}

const twoCodeUnits: CustomTokenizer = {
  tokenize(text: string) {
    const tokens: Array<{ token: string; position: number }> = []
    if (text.startsWith('#')) {
      tokens.push({ token: '', position: 0 })
      text = text.slice(1)
    }
    for (let start = 0; start < text.length; start += CODE_UNITS_PER_TOKEN) {
      tokens.push({ token: text.slice(start, start + CODE_UNITS_PER_TOKEN), position: tokens.length })
    }
    return tokens
  },
}

describe('a custom tokeniser that cuts a surrogate pair in half', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-custom-token-surrogates-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('finds the same documents before and after a restart', async () => {
    registerTokenizer(TOKENIZER_NAME, twoCodeUnits)
    engine = await open(dir)
    await engine.createIndex('notes', { schema: { title: 'string' }, tokenizer: TOKENIZER_NAME })
    await engine.insert('notes', { id: 'smile', title: '#a\u{1F600}ba\u{1F600}b\u{1F600}' })
    await engine.insert('notes', { id: 'replaced', title: 'a\u{FFFD}cd' })
    await engine.insert('notes', { id: 'plain', title: 'abcd' })

    const before = await engine.query('notes', { term: 'a\u{1F600}bzz' })
    expect(before.hits.map(hit => hit.id).sort()).toEqual(['replaced', 'smile'])
    expect((await engine.query('notes', { term: '\u{1F600}' })).hits.map(hit => hit.id)).toEqual(['smile'])
    const repeated = await engine.query('notes', { term: 'a\u{FFFD}' })
    expect(repeated.hits).toHaveLength(2)
    for (const hit of repeated.hits) {
      const frequency = hit.id === 'smile' ? 2 : 1
      const length = hit.id === 'smile' ? 6 : 2
      const expected = (Math.log(1.6) * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * length) / (10 / 3)))
      expect(hit.score).toBeCloseTo(expected, 10)
    }

    await engine.checkpoint('notes')
    expect((await requireManifestOnDisk(dir, 'notes')).partitions.length).toBeGreaterThan(0)
    await engine.shutdown()
    engine = await open(dir)

    const after = await engine.query('notes', { term: 'a\u{1F600}bzz' })
    expect(after.hits.map(hit => [hit.id, hit.score])).toEqual(before.hits.map(hit => [hit.id, hit.score]))
  })
})
