import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { Narsil } from '../../../types/engine'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => undefined
  const promise = new Promise<void>(resolve => {
    settle = resolve
  })
  return { promise, resolve: () => settle() }
}

describe('a drop that arrives while a closed index reopens', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  it('reads nothing that the drop deletes and leaves no index or file behind', async () => {
    const storage = createMemoryPersistence()
    const deleted = deferred()
    let holdRecovery = false
    let recoveryLoads = 0
    const adapter: PersistenceAdapter = {
      save: (key, data) => storage.save(key, data),
      async load(key) {
        if (holdRecovery && key.startsWith('products/')) {
          recoveryLoads += 1
          await deleted.promise
        }
        return storage.load(key)
      },
      async delete(key) {
        await storage.delete(key)
        if (key.startsWith('products/')) deleted.resolve()
      },
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.close('products')
    holdRecovery = true

    const reading = engine.get('products', 'lamp')
    const dropping = engine.dropIndex('products')
    const [read, dropped] = await Promise.allSettled([reading, dropping])

    expect(dropped.status).toBe('fulfilled')
    expect(read).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({ code: ErrorCodes.INDEX_NOT_FOUND }),
    })
    expect(recoveryLoads).toBe(0)
    expect(engine.listIndexes()).toEqual([])
    expect(await storage.list('products/')).toEqual([])

    await engine.createIndex('products', { schema: { title: 'string' } })
    expect(await engine.countDocuments('products')).toBe(0)
  })
})
