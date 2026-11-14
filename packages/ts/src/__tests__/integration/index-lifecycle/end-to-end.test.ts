import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'

describe('Index Lifecycle Integration', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('rejects a field name that cannot be encoded in a segment key at createIndex', async () => {
    await expect(
      narsil.createIndex('media', { schema: { title: 'string', 'image-embedding': 'vector[4]' } }),
    ).rejects.toThrow(/not allowed/)
    expect(narsil.listIndexes().length).toBe(0)
  })
})
