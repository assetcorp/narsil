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

  it('rejects keys containing null bytes', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.save('bad\0key', new Uint8Array([1]))).rejects.toThrow(NarsilError)
    await expect(adapter.save('bad\0key', new Uint8Array([1]))).rejects.toThrow('Invalid key: null byte detected')
  })

  it('refuses every key that climbs out of its directory, on save, load, and delete', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })

    await expect(adapter.save('../escape', new Uint8Array([1]))).rejects.toThrow('Invalid key: path traversal detected')
    await expect(adapter.save('legit/../../escape', new Uint8Array([1]))).rejects.toThrow(
      'Invalid key: path traversal detected',
    )
    await expect(adapter.load('../secret')).rejects.toThrow('Invalid key: path traversal detected')
    await expect(adapter.delete('../secret')).rejects.toThrow('Invalid key: path traversal detected')
  })

  it('writes atomically through a temporary file and leaves no temporary artifacts', async () => {
    const adapter = createFilesystemPersistence({ directory: tempDir })
    const data = new Uint8Array(1 << 20)
    for (let i = 0; i < data.length; i += 1) {
      data[i] = i & 0xff
    }

    await adapter.save('movies/snapshot', data)
    await adapter.save('movies/snapshot', data)

    const loaded = await adapter.load('movies/snapshot')
    expect(loaded).toEqual(data)

    const entries = await readdir(join(tempDir, 'movies'))
    expect(entries).toEqual(['snapshot'])
  }, 30_000)
})
