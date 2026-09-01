import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'

const schema = { title: 'string' as const }

describe('restore and the index registry', () => {
  let directory = ''
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-restore-registration-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it('answers listIndexes throughout a restore', async () => {
    engine = await createNarsil({ durability: { directory } })
    await engine.createIndex('prose', { schema })
    const documents = Array.from({ length: 120 }, (_, position) => ({ title: `document ${position}` }))
    await engine.insertBatch('prose', documents)
    const data = await engine.snapshot('prose')

    const restoring = engine.restore('copy', data)
    let done = false
    let polls = 0
    const settled = restoring.finally(() => {
      done = true
    })
    while (!done) {
      engine.listIndexes()
      polls += 1
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    await settled

    expect(polls).toBeGreaterThan(0)
    expect(
      engine
        .listIndexes()
        .map(index => index.name)
        .sort(),
    ).toEqual(['copy', 'prose'])
    expect(await engine.countDocuments('copy')).toBe(120)
  }, 20_000)

  it('leaves no trace when a restore fails after registration', async () => {
    engine = await createNarsil({ durability: { directory } })
    const payload = encode({
      version: 2,
      schema: { title: 'string' },
      language: 'english',
      surfaceForms: true,
      partitions: [new Uint8Array([1, 2, 3])],
      vectorIndexes: {},
    })

    await expect(engine.restore('broken', payload)).rejects.toBeTruthy()

    expect(engine.listIndexes()).toEqual([])
    await engine.createIndex('broken', { schema })
    await engine.insert('broken', { title: 'fresh' })
    expect(await engine.countDocuments('broken')).toBe(1)
  })
})
