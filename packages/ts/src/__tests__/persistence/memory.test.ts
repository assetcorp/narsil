import { describe, expect, it } from 'vitest'
import { createMemoryPersistence } from '../../persistence/memory'

describe('createMemoryPersistence', () => {
  it('saves and loads data in a round-trip', async () => {
    const adapter = createMemoryPersistence()
    const data = new Uint8Array([10, 20, 30, 40, 50])

    await adapter.save('products/0', data)
    const loaded = await adapter.load('products/0')

    expect(loaded).toEqual(data)
  })

  it('returns null when loading a key that does not exist', async () => {
    const adapter = createMemoryPersistence()
    const loaded = await adapter.load('nonexistent-key')

    expect(loaded).toBeNull()
  })

  it('overwrites existing data on save with the same key', async () => {
    const adapter = createMemoryPersistence()
    const original = new Uint8Array([1, 2, 3])
    const updated = new Uint8Array([4, 5, 6, 7])

    await adapter.save('catalog/1', original)
    await adapter.save('catalog/1', updated)
    const loaded = await adapter.load('catalog/1')

    expect(loaded).toEqual(updated)
  })

  it('deletes a stored key', async () => {
    const adapter = createMemoryPersistence()
    const data = new Uint8Array([99])

    await adapter.save('temp/0', data)
    await adapter.delete('temp/0')
    const loaded = await adapter.load('temp/0')

    expect(loaded).toBeNull()
  })

  it('does not throw when deleting a key that does not exist', async () => {
    const adapter = createMemoryPersistence()
    await expect(adapter.delete('missing-key')).resolves.toBeUndefined()
  })

  it('lists keys matching a given prefix', async () => {
    const adapter = createMemoryPersistence()
    await adapter.save('orders/0', new Uint8Array([1]))
    await adapter.save('orders/1', new Uint8Array([2]))
    await adapter.save('orders/2', new Uint8Array([3]))
    await adapter.save('users/0', new Uint8Array([4]))

    const orderKeys = await adapter.list('orders/')
    expect(orderKeys).toHaveLength(3)
    expect(orderKeys).toContain('orders/0')
    expect(orderKeys).toContain('orders/1')
    expect(orderKeys).toContain('orders/2')

    const userKeys = await adapter.list('users/')
    expect(userKeys).toHaveLength(1)
    expect(userKeys).toContain('users/0')
  })

  it('returns an empty array when no keys match the prefix', async () => {
    const adapter = createMemoryPersistence()
    await adapter.save('data/0', new Uint8Array([1]))

    const result = await adapter.list('unknown/')
    expect(result).toEqual([])
  })

  it('isolates stored data from external mutation of the input', async () => {
    const adapter = createMemoryPersistence()
    const data = new Uint8Array([10, 20, 30])

    await adapter.save('isolated/0', data)
    data[0] = 255

    const loaded = await adapter.load('isolated/0')
    expect(loaded).toEqual(new Uint8Array([10, 20, 30]))
  })

  it('isolates loaded data from external mutation of the output', async () => {
    const adapter = createMemoryPersistence()
    await adapter.save('isolated/1', new Uint8Array([5, 10, 15]))

    const firstLoad = await adapter.load('isolated/1')
    const loadedData = firstLoad as Uint8Array
    loadedData[0] = 255

    const secondLoad = await adapter.load('isolated/1')
    expect(secondLoad).toEqual(new Uint8Array([5, 10, 15]))
  })

  it('handles empty Uint8Array data', async () => {
    const adapter = createMemoryPersistence()
    await adapter.save('empty/0', new Uint8Array([]))
    const loaded = await adapter.load('empty/0')

    expect(loaded).toEqual(new Uint8Array([]))
  })

  it('handles multiple independent adapters without interference', async () => {
    const adapter1 = createMemoryPersistence()
    const adapter2 = createMemoryPersistence()

    await adapter1.save('shared-key', new Uint8Array([1]))
    await adapter2.save('shared-key', new Uint8Array([2]))

    const from1 = await adapter1.load('shared-key')
    const from2 = await adapter2.load('shared-key')

    expect(from1).toEqual(new Uint8Array([1]))
    expect(from2).toEqual(new Uint8Array([2]))
  })
})
