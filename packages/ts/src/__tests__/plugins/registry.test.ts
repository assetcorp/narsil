import { describe, expect, it, vi } from 'vitest'
import { createPluginRegistry } from '../../plugins/registry'
import type { NarsilPlugin } from '../../types/plugins'

describe('createPluginRegistry', () => {
  it('returns a registry with register and runHook methods', () => {
    const registry = createPluginRegistry()
    expect(typeof registry.register).toBe('function')
    expect(typeof registry.runHook).toBe('function')
  })
})

describe('PluginRegistry.register', () => {
  it('accepts a plugin without throwing', () => {
    const registry = createPluginRegistry()
    const plugin: NarsilPlugin = { name: 'test-plugin' }
    expect(() => registry.register(plugin)).not.toThrow()
  })

  it('accepts multiple plugins', () => {
    const registry = createPluginRegistry()
    registry.register({ name: 'plugin-a' })
    registry.register({ name: 'plugin-b' })
    registry.register({ name: 'plugin-c' })
  })
})

describe('PluginRegistry.runHook', () => {
  it('returns undefined when no plugins are registered', () => {
    const registry = createPluginRegistry()
    const result = registry.runHook('beforeInsert', { indexName: 'products', docId: '1', document: {} })
    expect(result).toBeUndefined()
  })

  it('returns undefined when no plugin implements the requested hook', () => {
    const registry = createPluginRegistry()
    registry.register({ name: 'empty-plugin' })
    const result = registry.runHook('beforeInsert', { indexName: 'products', docId: '1', document: {} })
    expect(result).toBeUndefined()
  })

  it('calls a sync hook with the correct context', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'spy-plugin', beforeInsert: hook })

    const ctx = { indexName: 'products', docId: 'doc-1', document: { title: 'Widget' } }
    registry.runHook('beforeInsert', ctx)

    expect(hook).toHaveBeenCalledOnce()
    expect(hook).toHaveBeenCalledWith(ctx)
  })

  it('calls hooks on multiple plugins in registration order', () => {
    const registry = createPluginRegistry()
    const order: string[] = []

    registry.register({
      name: 'first',
      beforeInsert: () => {
        order.push('first')
      },
    })
    registry.register({
      name: 'second',
      beforeInsert: () => {
        order.push('second')
      },
    })
    registry.register({
      name: 'third',
      beforeInsert: () => {
        order.push('third')
      },
    })

    registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('returns void for purely sync hooks', () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'sync-plugin',
      afterRemove: () => {},
    })

    const result = registry.runHook('afterRemove', { indexName: 'idx', docId: '1' })
    expect(result).toBeUndefined()
  })

  it('returns a Promise when an async hook is encountered', async () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'async-plugin',
      beforeInsert: async () => {},
    })

    const result = registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  it('handles mixed sync/async hooks and runs them in order', async () => {
    const registry = createPluginRegistry()
    const order: string[] = []

    registry.register({
      name: 'sync-first',
      beforeSearch: () => {
        order.push('sync-first')
      },
    })
    registry.register({
      name: 'async-middle',
      beforeSearch: async () => {
        await new Promise(r => setTimeout(r, 10))
        order.push('async-middle')
      },
    })
    registry.register({
      name: 'sync-last',
      beforeSearch: () => {
        order.push('sync-last')
      },
    })

    const result = registry.runHook('beforeSearch', { indexName: 'idx', params: {} })
    expect(result).toBeInstanceOf(Promise)
    await result

    expect(order).toEqual(['sync-first', 'async-middle', 'sync-last'])
  })

  it('detects thenables from sync functions that return promises', async () => {
    const registry = createPluginRegistry()
    const order: string[] = []

    registry.register({
      name: 'sneaky-async',
      beforeInsert: () => {
        return Promise.resolve().then(() => {
          order.push('sneaky-async')
        })
      },
    })
    registry.register({
      name: 'after-sneaky',
      beforeInsert: () => {
        order.push('after-sneaky')
      },
    })

    const result = registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    expect(result).toBeInstanceOf(Promise)
    await result

    expect(order).toEqual(['sneaky-async', 'after-sneaky'])
  })

  it('skips plugins that do not implement the hook', () => {
    const registry = createPluginRegistry()
    const hookA = vi.fn()
    const hookC = vi.fn()

    registry.register({ name: 'plugin-a', afterInsert: hookA })
    registry.register({ name: 'plugin-b' })
    registry.register({ name: 'plugin-c', afterInsert: hookC })

    registry.runHook('afterInsert', { indexName: 'idx', docId: '1', document: {} })

    expect(hookA).toHaveBeenCalledOnce()
    expect(hookC).toHaveBeenCalledOnce()
  })

  it('routes different hook names to different hook methods', () => {
    const registry = createPluginRegistry()
    const beforeInsert = vi.fn()
    const afterInsert = vi.fn()
    const beforeRemove = vi.fn()

    registry.register({ name: 'multi-hook', beforeInsert, afterInsert, beforeRemove })

    registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    expect(beforeInsert).toHaveBeenCalledOnce()
    expect(afterInsert).not.toHaveBeenCalled()
    expect(beforeRemove).not.toHaveBeenCalled()
  })

  it('passes InsertContext to insert hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', afterInsert: hook })

    const ctx = { indexName: 'products', docId: 'abc', document: { name: 'Sword' } }
    registry.runHook('afterInsert', ctx)

    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('passes RemoveContext to remove hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', beforeRemove: hook })

    registry.runHook('beforeRemove', { indexName: 'products', docId: 'abc' })
    expect(hook.mock.calls[0][0]).toEqual({ indexName: 'products', docId: 'abc' })
  })

  it('passes UpdateContext to update hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', beforeUpdate: hook })

    const ctx = { indexName: 'idx', docId: '1', oldDocument: { v: 1 }, newDocument: { v: 2 } }
    registry.runHook('beforeUpdate', ctx)
    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('passes SearchContext to search hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', afterSearch: hook })

    const ctx = { indexName: 'idx', params: { term: 'sword' } }
    registry.runHook('afterSearch', ctx)
    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('passes IndexContext to index lifecycle hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', onIndexCreate: hook })

    const ctx = { indexName: 'products', config: { schema: { title: 'string' as const } } }
    registry.runHook('onIndexCreate', ctx)
    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('passes PartitionContext to partition hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', onPartitionSplit: hook })

    const ctx = { indexName: 'products', oldPartitionCount: 2, newPartitionCount: 4 }
    registry.runHook('onPartitionSplit', ctx)
    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('passes WorkerContext to worker hooks', () => {
    const registry = createPluginRegistry()
    const hook = vi.fn()
    registry.register({ name: 'p', onWorkerPromote: hook })

    const ctx = { workerCount: 4, reason: 'threshold exceeded' }
    registry.runHook('onWorkerPromote', ctx)
    expect(hook.mock.calls[0][0]).toEqual(ctx)
  })

  it('awaits all async hooks before resolving', async () => {
    const registry = createPluginRegistry()
    let completed = false

    registry.register({
      name: 'slow',
      beforeInsert: async () => {
        await new Promise(r => setTimeout(r, 30))
        completed = true
      },
    })

    await registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    expect(completed).toBe(true)
  })

  it('propagates errors thrown by sync hooks', () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'exploding',
      beforeInsert: () => {
        throw new Error('plugin failed')
      },
    })

    expect(() => {
      registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })
    }).toThrow('plugin failed')
  })

  it('propagates rejections from async hooks', async () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'rejecting',
      beforeInsert: async () => {
        throw new Error('async plugin failed')
      },
    })

    await expect(registry.runHook('beforeInsert', { indexName: 'idx', docId: '1', document: {} })).rejects.toThrow(
      'async plugin failed',
    )
  })
})
