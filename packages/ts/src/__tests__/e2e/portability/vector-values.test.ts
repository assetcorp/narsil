import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { EmbeddingAdapter } from '../../../types/adapters'
import type { FieldType } from '../../../types/schema'

const engines: Narsil[] = []
const LARGEST_FLOAT32 = 3.4028234663852886e38
const SMALLEST_DOUBLE_ROUNDING_TO_FLOAT32_INFINITY = 2 ** 128 - 2 ** 103
const DOUBLE_BEYOND_FLOAT32 = 1e39
const DIMENSION = 4

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
})

async function engineWith(options: Parameters<typeof createNarsil>[0] = {}): Promise<Narsil> {
  const engine = await createNarsil({ workers: { enabled: false }, ...options })
  engines.push(engine)
  return engine
}

async function vectorIndex(): Promise<Narsil> {
  const engine = await engineWith()
  await engine.createIndex('items', { schema: { title: 'string', embedding: `vector[${DIMENSION}]` } })
  await engine.insert('items', { title: 'north', embedding: [1, 0, 0, 0] }, 'north')
  await engine.insert('items', { title: 'east', embedding: [0, 1, 0, 0] }, 'east')
  return engine
}

function withFirst(first: number): number[] {
  return [first, 0.5, 0.5, 0.5]
}

const unusableVectors: Array<[string, number[] | Float32Array]> = [
  ['a double beyond the float32 range', withFirst(DOUBLE_BEYOND_FLOAT32)],
  ['a double that rounds to float32 infinity', withFirst(SMALLEST_DOUBLE_ROUNDING_TO_FLOAT32_INFINITY)],
  ['NaN in a plain list', withFirst(Number.NaN)],
  ['NaN in a Float32Array', Float32Array.from(withFirst(Number.NaN))],
  ['infinity in a Float32Array', Float32Array.from(withFirst(Number.POSITIVE_INFINITY))],
]

describe('the dimension of a vector field', () => {
  it.each([
    'vector[1.5]',
    'vector[-1]',
    'vector[+4]',
    'vector[4.0]',
    'vector[1e3]',
    'vector[0]',
    'vector[4097]',
    'vector[]',
    'vector[abc]',
    'vector[ 4]',
  ])('refuses %s with SCHEMA_INVALID_VECTOR_DIMENSION', async type => {
    const engine = await engineWith()
    await expect(engine.createIndex('items', { schema: { embedding: type as FieldType } })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
    })
  })

  it.each(['vector', 'vectors[4]', 'vector(4)', 'vector[4]x'])('refuses %s as an unknown type', async type => {
    const engine = await engineWith()
    await expect(engine.createIndex('items', { schema: { embedding: type as FieldType } })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_TYPE,
    })
  })
})

describe('a document vector whose float32 form is infinite or NaN', () => {
  it.each(unusableVectors)('refuses %s on insert, in a batch, and on update', async (_name, embedding) => {
    const engine = await vectorIndex()

    await expect(engine.insert('items', { title: 'bad', embedding }, 'bad')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    const batch = await engine.insertBatch('items', [
      { id: 'west', title: 'west', embedding: [-1, 0, 0, 0] },
      { id: 'bad-in-batch', title: 'bad', embedding },
    ])
    expect(batch.succeeded).toEqual(['west'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['bad-in-batch', ErrorCodes.DOC_VALIDATION_FAILED],
    ])
    await expect(engine.update('items', 'north', { title: 'north', embedding })).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })

    const hits = (await engine.query('items', { vector: { field: 'embedding', value: [1, 0, 0, 0] }, limit: 10 })).hits
    expect(hits.map(hit => hit.id).sort()).toEqual(['east', 'north', 'west'])
    expect(hits.every(hit => Number.isFinite(hit.score))).toBe(true)
    expect(hits[0]?.id).toBe('north')
  })

  it('keeps the largest float32 value', async () => {
    const engine = await vectorIndex()
    await engine.insert('items', { title: 'largest', embedding: withFirst(LARGEST_FLOAT32) }, 'largest')

    const stored = (await engine.get('items', 'largest'))?.embedding
    expect(Array.from(stored as ArrayLike<number>)).toEqual(withFirst(LARGEST_FLOAT32).map(Math.fround))
  })
})

describe('a query vector whose float32 form is infinite or NaN', () => {
  it.each(unusableVectors)('refuses %s in a vector query and in a hybrid query', async (_name, value) => {
    const engine = await vectorIndex()

    await expect(engine.query('items', { vector: { field: 'embedding', value } })).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    await expect(
      engine.query('items', { term: 'north', mode: 'hybrid', vector: { field: 'embedding', value } }),
    ).rejects.toMatchObject({ code: ErrorCodes.DOC_VALIDATION_FAILED })
  })
})

describe('an embedding adapter that returns an infinite element', () => {
  function adapterReturningInfinityFor(poisoned: string): EmbeddingAdapter {
    return {
      dimensions: DIMENSION,
      async embed(input) {
        return Float32Array.from(withFirst(input === poisoned ? Number.POSITIVE_INFINITY : 1))
      },
    }
  }

  it('fails the document and the query with EMBEDDING_FAILED', async () => {
    const engine = await engineWith({ embedding: adapterReturningInfinityFor('poisoned') })
    await engine.createIndex('items', {
      schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
      embedding: { fields: { embedding: ['title'] } },
    })
    await engine.insert('items', { title: 'healthy' }, 'healthy')

    await expect(engine.insert('items', { title: 'poisoned' }, 'poisoned')).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
    })
    await expect(engine.query('items', { vector: { field: 'embedding', text: 'poisoned' } })).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
    })
    expect(await engine.countDocuments('items')).toBe(1)
  })
})
