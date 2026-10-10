import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { engineCoreOf } from '../../narsil/internals'
import { indexConfig } from './fixtures'

function nextWrite(narsil: Narsil): Promise<{ indexName: string; documentCount: number }> {
  return new Promise(resolve => {
    const handler = (payload: { indexName: string }): void => {
      narsil.off('write', handler)
      const listed = narsil.listIndexes().find(entry => entry.name === payload.indexName)
      resolve({ indexName: payload.indexName, documentCount: listed?.documentCount ?? -1 })
    }
    narsil.on('write', handler)
  })
}

describe('the write event', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('names the index after every call that changes what it holds, once the change is visible', async () => {
    const seen: string[] = []
    const record = (payload: { indexName: string }): void => {
      seen.push(payload.indexName)
    }
    narsil.on('write', record)

    const created = nextWrite(narsil)
    await narsil.createIndex('products', indexConfig)
    expect(await created).toEqual({ indexName: 'products', documentCount: 0 })

    const inserted = nextWrite(narsil)
    await narsil.insert('products', { title: 'Wireless Headphones', category: 'audio', price: 99 }, 'p1')
    expect(await inserted).toEqual({ indexName: 'products', documentCount: 1 })

    const batched = nextWrite(narsil)
    await narsil.insertBatch('products', [
      { id: 'p2', title: 'Bluetooth Speaker', category: 'audio', price: 49 },
      { id: 'p3', title: 'Desk Lamp', category: 'home', price: 25 },
    ])
    expect(await batched).toEqual({ indexName: 'products', documentCount: 3 })

    await narsil.update('products', 'p1', { title: 'Wired Headphones', category: 'audio', price: 59 })
    await narsil.updateBatch('products', [
      { docId: 'p2', document: { title: 'Bluetooth Speaker', category: 'audio', price: 39 } },
    ])
    await narsil.remove('products', 'p3')
    await narsil.removeBatch('products', ['p2'])
    const bytes = await narsil.snapshot('products')
    await narsil.clear('products')
    await narsil.restore('products', bytes)
    await narsil.rebalance('products', 2)
    await vi.waitFor(() => expect(seen).toHaveLength(10))

    const archived = nextWrite(narsil)
    await narsil.createIndex('archive', indexConfig)
    expect(await archived).toEqual({ indexName: 'archive', documentCount: 0 })

    const dropped = nextWrite(narsil)
    await narsil.dropIndex('archive')
    expect(await dropped).toEqual({ indexName: 'archive', documentCount: -1 })

    await vi.waitFor(() => expect(seen).toHaveLength(12))
    expect(seen.filter(name => name === 'products')).toHaveLength(10)
    expect(seen.filter(name => name === 'archive')).toHaveLength(2)

    const refused = nextWrite(narsil)
    await expect(narsil.remove('products', 'absent')).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' })
    expect(await refused).toEqual({ indexName: 'products', documentCount: 1 })
  })

  it('does no work for the event while nobody listens', async () => {
    await narsil.createIndex('products', indexConfig)
    const core = engineCoreOf(narsil)
    if (core === undefined) throw new Error('The engine has no core bound to it')
    const visibilityWaits = vi.spyOn(core.orchestrator, 'awaitWrites')

    await narsil.insert('products', { title: 'Desk Lamp', category: 'home', price: 25 }, 'p1')
    expect(visibilityWaits).not.toHaveBeenCalled()

    const seen: string[] = []
    const record = (payload: { indexName: string }): void => {
      seen.push(payload.indexName)
    }
    narsil.on('write', record)
    await narsil.insert('products', { title: 'Floor Lamp', category: 'home', price: 75 }, 'p2')
    await vi.waitFor(() => expect(seen).toEqual(['products']))
    expect(visibilityWaits).toHaveBeenCalledTimes(1)

    narsil.off('write', record)
    await narsil.remove('products', 'p1')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(seen).toEqual(['products'])
    expect(visibilityWaits).toHaveBeenCalledTimes(1)
  })
})
