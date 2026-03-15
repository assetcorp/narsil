import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createFilesystemPersistence } from '../../persistence/filesystem'

describe('createFilesystemPersistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'narsil-fs-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves and loads data in a round-trip', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const data = new Uint8Array([10, 20, 30, 40, 50])

    await adapter.save('products-0', data)
    const loaded = await adapter.load('products-0')

    expect(loaded).toEqual(data)
  })

  it('returns null when loading a key that does not exist', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const loaded = await adapter.load('nonexistent-key')

    expect(loaded).toBeNull()
  })

  it('overwrites existing data on save with the same key', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const original = new Uint8Array([1, 2, 3])
    const updated = new Uint8Array([4, 5, 6, 7])

    await adapter.save('catalog-1', original)
    await adapter.save('catalog-1', updated)
    const loaded = await adapter.load('catalog-1')

    expect(loaded).toEqual(updated)
  })

  it('deletes a stored key', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const data = new Uint8Array([99])

    await adapter.save('temp-0', data)
    await adapter.delete('temp-0')
    const loaded = await adapter.load('temp-0')

    expect(loaded).toBeNull()
  })

  it('does not throw when deleting a key that does not exist', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    await expect(adapter.delete('missing-key')).resolves.toBeUndefined()
  })

  it('lists keys matching a given prefix', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    await adapter.save('orders-0', new Uint8Array([1]))
    await adapter.save('orders-1', new Uint8Array([2]))
    await adapter.save('orders-2', new Uint8Array([3]))
    await adapter.save('users-0', new Uint8Array([4]))

    const orderKeys = await adapter.list('orders-')
    expect(orderKeys).toHaveLength(3)
    expect(orderKeys).toContain('orders-0')
    expect(orderKeys).toContain('orders-1')
    expect(orderKeys).toContain('orders-2')

    const userKeys = await adapter.list('users-')
    expect(userKeys).toHaveLength(1)
    expect(userKeys).toContain('users-0')
  })

  it('returns an empty array when no keys match the prefix', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    await adapter.save('data-0', new Uint8Array([1]))

    const result = await adapter.list('unknown-')
    expect(result).toEqual([])
  })

  it('returns an empty array when listing from a nonexistent directory', async () => {
    const adapter = createFilesystemPersistence({ directory: join(tempDir, 'does-not-exist') })
    const result = await adapter.list('anything')
    expect(result).toEqual([])
  })

  it('auto-creates nested directories when saving with path-like keys', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const data = new Uint8Array([42])

    await adapter.save('indexes/products/partition-0', data)
    const loaded = await adapter.load('indexes/products/partition-0')

    expect(loaded).toEqual(data)

    const topLevel = await readdir(join(tempDir, 'indexes'))
    expect(topLevel).toContain('products')
  })

  it('rejects keys containing null bytes', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.save('bad\0key', new Uint8Array([1]))).rejects.toThrow(NarsilError)
    await expect(adapter.save('bad\0key', new Uint8Array([1]))).rejects.toThrow('Invalid key: null byte detected')
  })

  it('rejects keys that attempt path traversal with ../', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.save('../escape', new Uint8Array([1]))).rejects.toThrow(NarsilError)
    await expect(adapter.save('../escape', new Uint8Array([1]))).rejects.toThrow('Invalid key: path traversal detected')
  })

  it('rejects keys that attempt path traversal with nested ../', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.save('legit/../../escape', new Uint8Array([1]))).rejects.toThrow(
      'Invalid key: path traversal detected',
    )
  })

  it('path traversal protection applies to load and delete too', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.load('../secret')).rejects.toThrow('Invalid key: path traversal detected')
    await expect(adapter.delete('../secret')).rejects.toThrow('Invalid key: path traversal detected')
  })

  it('throws when directory config is an empty string', () => {
    expect(() => createFilesystemPersistence({ directory: '' })).toThrow(NarsilError)
  })

  it('throws when directory config is whitespace only', () => {
    expect(() => createFilesystemPersistence({ directory: '   ' })).toThrow(NarsilError)
  })

  it('lists keys from nested directories with correct relative paths', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    await adapter.save('idx/p0', new Uint8Array([1]))
    await adapter.save('idx/p1', new Uint8Array([2]))
    await adapter.save('other/p0', new Uint8Array([3]))

    const keys = await adapter.list('idx/')
    expect(keys).toHaveLength(2)
    expect(keys).toContain('idx/p0')
    expect(keys).toContain('idx/p1')
  })
})
