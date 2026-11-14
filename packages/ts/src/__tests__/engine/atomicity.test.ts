import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const DIM = 4

const schema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}

function vec4(...values: number[]): number[] {
  const v = new Array(DIM).fill(0)
  for (let i = 0; i < values.length && i < DIM; i++) {
    v[i] = values[i]
  }
  return v
}

describe('insert atomicity', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('rolls back the partition insert when a wrong-dimension vector is provided', async () => {
    await narsil.createIndex('idx', { schema, language: 'english' })

    const wrongDimVector = [1, 2, 3, 4, 5, 6, 7, 8]

    await expect(narsil.insert('idx', { title: 'bad vector', embedding: wrongDimVector })).rejects.toThrow(NarsilError)

    const count = await narsil.countDocuments('idx')
    expect(count).toBe(0)
  })
})

describe('update atomicity', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('updates a document with valid vectors', async () => {
    await narsil.createIndex('idx', { schema, language: 'english' })

    const docId = await narsil.insert('idx', {
      title: 'original title',
      embedding: vec4(1, 0, 0, 0),
    })

    await narsil.update('idx', docId, {
      title: 'updated title',
      embedding: vec4(0, 1, 0, 0),
    })

    const doc = await narsil.get('idx', docId)
    expect(doc?.title).toBe('updated title')

    const vectorResult = await narsil.query('idx', {
      vector: { field: 'embedding', value: vec4(0, 1, 0, 0), metric: 'cosine' },
      limit: 1,
    })
    expect(vectorResult.hits).toHaveLength(1)
    expect(vectorResult.hits[0].id).toBe(docId)
  })

  it('rolls back to old state when update provides a wrong-dimension vector', async () => {
    await narsil.createIndex('idx', { schema, language: 'english' })

    const docId = await narsil.insert('idx', {
      title: 'original',
      embedding: vec4(1, 0, 0, 0),
    })

    try {
      await narsil.update('idx', docId, {
        title: 'should not persist',
        embedding: [1, 2, 3, 4, 5, 6, 7, 8],
      })
    } catch {
      /* expected */
    }

    const doc = await narsil.get('idx', docId)
    expect(doc?.title).toBe('original')
  })
})

describe('batch insert atomicity', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('one failing doc does not affect successful docs', async () => {
    await narsil.createIndex('idx', { schema, language: 'english' })

    const docs = [
      { title: 'good doc 1', embedding: vec4(1, 0, 0, 0) },
      { title: 'bad doc', embedding: [1, 2, 3, 4, 5, 6, 7, 8] },
      { title: 'good doc 2', embedding: vec4(0, 0, 1, 0) },
    ]

    const result = await narsil.insertBatch('idx', docs)

    expect(result.succeeded).toHaveLength(2)
    expect(result.failed).toHaveLength(1)

    const count = await narsil.countDocuments('idx')
    expect(count).toBe(2)
  })
})
