import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { writeLiveVectors } from '../../../persistence/durability/segment/vector'
import { createVectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector } from '../../vector/vector-index/fixtures'

describe('a vector file that a checkpoint writes while the field changes', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-write-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists a vector removed after the plan as dead, so that no reader restores its zeros', async () => {
    const index = createVectorIndex('embedding', DIM)
    for (let i = 0; i < 3; i += 1) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    const plan = index.planCheckpoint(null)
    index.remove('doc1')
    index.compact()

    const written = await writeLiveVectors({
      directory: createDurableDirectory(root),
      indexName: 'docs',
      plans: new Map([['embedding', plan]]),
      priorVectors: [],
    })

    expect(written.refs).toHaveLength(1)
    expect(written.refs[0].files).toHaveLength(1)
    expect(written.refs[0].files[0].count).toBe(3)
    expect(written.refs[0].files[0].dead).toEqual(new Uint8Array([0b010]))
  })

  it('lists no dead vector while the field stays as the plan found it', async () => {
    const index = createVectorIndex('embedding', DIM)
    for (let i = 0; i < 3; i += 1) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))

    const written = await writeLiveVectors({
      directory: createDurableDirectory(root),
      indexName: 'docs',
      plans: new Map([['embedding', index.planCheckpoint(null)]]),
      priorVectors: [],
    })

    expect(written.refs[0].files[0].dead).toBeNull()
  })
})
