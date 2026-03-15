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
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      /* cleanup best-effort */
    }
  })

  it('throws on directory paths containing path traversal', () => {
    expect(() => createFilesystemInvalidation({ directory: '/tmp/../etc/shadow' })).toThrow('path traversal')
  })

  it('publish creates a marker file in the directory', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'publisher-1',
    })

    await adapter.publish(createPartitionEvent('publisher-1'))

    const files = await fs.readdir(tmpDir)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/\.json$/)

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, files[0]), 'utf-8'))
    expect(content.type).toBe('partition')
    expect(content.instanceId).toBe('publisher-1')
    expect(typeof content.writtenAt).toBe('number')

    await adapter.shutdown()
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

  it('skips marker files written by own instance', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'self-instance',
      pollInterval: 50,
    })

    const received: InvalidationEvent[] = []
    await adapter.subscribe(event => {
      received.push(event)
    })

    await wait(80)
    await adapter.publish(createPartitionEvent('self-instance'))
    await wait(200)

    expect(received.length).toBe(0)

    await adapter.shutdown()
  })

  it('cleans up marker files older than 60 seconds', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'cleaner',
      pollInterval: 50,
    })

    const oldTimestamp = Date.now() - 70_000
    const oldFilename = `${oldTimestamp}-old-instance.json`
    const oldPayload = JSON.stringify({
      type: 'partition',
      indexName: 'test',
      partitions: [0],
      timestamp: oldTimestamp,
      sourceInstanceId: 'old-instance',
      instanceId: 'old-instance',
      writtenAt: oldTimestamp,
    })
    await fs.writeFile(path.join(tmpDir, oldFilename), oldPayload, 'utf-8')

    await adapter.subscribe(() => {})
    await wait(200)

    const files = await fs.readdir(tmpDir)
    const oldFileStillExists = files.some(f => f === oldFilename)
    expect(oldFileStillExists).toBe(false)

    await adapter.shutdown()
  })

  it('shutdown stops polling and removes own marker files', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
      instanceId: 'shutdown-test',
      pollInterval: 50,
    })

    await adapter.publish(createPartitionEvent('shutdown-test'))

    const filesBefore = await fs.readdir(tmpDir)
    expect(filesBefore.length).toBe(1)

    await adapter.shutdown()

    const filesAfter = await fs.readdir(tmpDir)
    const ownFiles = filesAfter.filter(f => f.includes('shutdown-test'))
    expect(ownFiles.length).toBe(0)
  })

  it('handles a missing directory in the poll loop gracefully', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist')
    const adapter = createFilesystemInvalidation({
      directory: missingDir,
      instanceId: 'missing-dir',
      pollInterval: 50,
    })

    const received: InvalidationEvent[] = []
    await adapter.subscribe(event => {
      received.push(event)
    })

    await wait(150)
    expect(received.length).toBe(0)

    await adapter.shutdown()
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
    const corruptStillExists = files.some(f => f === corruptFilename)
    expect(corruptStillExists).toBe(false)

    await adapter.shutdown()
  })

  it('auto-generates an instanceId when none is provided', async () => {
    const adapter = createFilesystemInvalidation({
      directory: tmpDir,
    })

    await adapter.publish(createPartitionEvent('source-1'))

    const files = await fs.readdir(tmpDir)
    expect(files.length).toBe(1)

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, files[0]), 'utf-8'))
    expect(typeof content.instanceId).toBe('string')
    expect(content.instanceId.length).toBeGreaterThan(0)

    await adapter.shutdown()
  })
})
