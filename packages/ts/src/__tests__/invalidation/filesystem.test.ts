import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFilesystemInvalidation } from '../../invalidation/filesystem'
import type { InvalidationEvent } from '../../types/adapters'

function createPartitionEvent(sourceInstanceId: string): InvalidationEvent {
  return {
    type: 'partition',
    indexName: 'test-index',
    partitions: [0, 1, 2],
    timestamp: Date.now(),
    sourceInstanceId,
  }
}

async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('createFilesystemInvalidation', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narsil-invalidation-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('throws on directory paths containing path traversal', () => {
    expect(() => createFilesystemInvalidation({ directory: '/tmp/../etc/shadow' })).toThrow('path traversal')
  })

  it('subscribe picks up events published by another instance', async () => {
    const publisher = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'publisher-a',
      pollInterval: 50,
    })

    const subscriber = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'subscriber-b',
      pollInterval: 50,
    })

    const received: InvalidationEvent[] = []
    await subscriber.subscribe(event => {
      received.push(event)
    })

    await wait(80)
    await publisher.publish(createPartitionEvent('publisher-a'))
    await wait(200)

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0].type).toBe('partition')

    await publisher.shutdown()
    await subscriber.shutdown()
  })

  it('handles corrupt JSON files by skipping and deleting them', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'corrupt-handler',
      pollInterval: 50,
    })

    const corruptFilename = `${Date.now() + 1000}-corrupt.json`
    await fs.writeFile(path.join(tmpDir, corruptFilename), '{ broken json !!!', 'utf-8')

    await adapter.subscribe(() => {})
    await wait(200)

    const files = await fs.readdir(tmpDir)
    expect(files.some(f => f === corruptFilename)).toBe(false)

    await adapter.shutdown()
  })
})
