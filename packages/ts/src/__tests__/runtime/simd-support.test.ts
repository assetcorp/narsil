import { describe, expect, it } from 'vitest'
import { createNarsil, isSimdAvailable } from '../../index'
import { loadedVectorCode } from '../../workers/vector-code'

describe('isSimdAvailable', () => {
  it('returns true at import in Node.js 22 before the engine loads any vector code', async () => {
    expect(loadedVectorCode()).toBeNull()
    expect(isSimdAvailable()).toBe(true)

    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('products', { schema: { title: 'string', price: 'number' } })
    await narsil.insert('products', { title: 'Trail running shoes', price: 120 })
    expect(loadedVectorCode()).toBeNull()
    expect(isSimdAvailable()).toBe(true)

    await narsil.createIndex('images', { schema: { caption: 'string', embedding: 'vector[3]' } })
    expect(loadedVectorCode()).not.toBeNull()
    expect(isSimdAvailable()).toBe(true)
    await narsil.shutdown()
  })
})
