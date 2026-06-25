import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'

describe('durable directory', () => {
  let root: string
  let directory: DurableDirectory

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-durable-'))
    directory = createDurableDirectory(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('appends framed bytes and reads them back', async () => {
    const handle = await directory.appendHandle('movies/wal/0/0000000000000001')
    await handle.append(new Uint8Array([1, 2, 3]))
    await handle.append(new Uint8Array([4, 5]))
    await handle.sync()
    await handle.close()

    const data = await directory.read('movies/wal/0/0000000000000001')
    expect(data).not.toBeNull()
    expect([...(data ?? [])]).toEqual([1, 2, 3, 4, 5])
  })

  it('reports the current file size', async () => {
    const handle = await directory.appendHandle('movies/segment')
    await handle.append(new Uint8Array(7))
    expect(await handle.size()).toBe(7)
    await handle.close()
  })

  it('truncates a file to a clean byte length', async () => {
    const handle = await directory.appendHandle('movies/segment')
    await handle.append(new Uint8Array([1, 2, 3, 4, 5]))
    await handle.truncate(3)
    await handle.close()
    const data = await directory.read('movies/segment')
    expect([...(data ?? [])]).toEqual([1, 2, 3])
  })

  it('writes a snapshot atomically and durably', async () => {
    await directory.atomicWrite('movies/snapshot', new Uint8Array([9, 9, 9]))
    const onDisk = await readFile(join(root, 'movies', 'snapshot'))
    expect([...onDisk]).toEqual([9, 9, 9])
  })

  it('overwrites an existing file via atomic rename', async () => {
    await directory.atomicWrite('movies/snapshot', new Uint8Array([1]))
    await directory.atomicWrite('movies/snapshot', new Uint8Array([2, 2]))
    const data = await directory.read('movies/snapshot')
    expect([...(data ?? [])]).toEqual([2, 2])
  })

  it('returns null when reading a missing key', async () => {
    expect(await directory.read('movies/missing')).toBeNull()
  })

  it('lists keys under a prefix in sorted order', async () => {
    await directory.atomicWrite('movies/wal/0/0000000000000003', new Uint8Array([3]))
    await directory.atomicWrite('movies/wal/0/0000000000000001', new Uint8Array([1]))
    await directory.atomicWrite('movies/snapshot', new Uint8Array([0]))

    const walKeys = await directory.list('movies/wal/0/')
    expect(walKeys).toEqual(['movies/wal/0/0000000000000001', 'movies/wal/0/0000000000000003'])
  })

  it('removes a key without failing when it is already gone', async () => {
    await directory.atomicWrite('movies/snapshot', new Uint8Array([1]))
    await directory.remove('movies/snapshot')
    await directory.remove('movies/snapshot')
    expect(await directory.read('movies/snapshot')).toBeNull()
  })

  it('rejects a key with a null byte', async () => {
    await expect(directory.read(`movies/${String.fromCharCode(0)}bad`)).rejects.toBeInstanceOf(NarsilError)
  })

  it('rejects a path-traversal key', async () => {
    await expect(directory.read('../escape')).rejects.toBeInstanceOf(NarsilError)
  })

  it('rejects an empty root', () => {
    expect(() => createDurableDirectory('   ')).toThrow(NarsilError)
  })
})
