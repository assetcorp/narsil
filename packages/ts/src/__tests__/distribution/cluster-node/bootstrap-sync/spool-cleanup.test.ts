import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBootstrapSyncState, runBootstrapSync } from '../../../../distribution/cluster-node/bootstrap-sync'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/constants'
import { createReplicationLog } from '../../../../distribution/replication/log'
import type { ReplicationLog } from '../../../../distribution/replication/types'
import {
  type NodeTransport,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../../errors'
import { crc32 } from '../../../../serialization/crc32'
import { bytesOf } from '../../../e2e/portability/archive-oracle'
import {
  buildSnapshotChunkBytes,
  buildSnapshotEndBytes,
  buildSnapshotStartBytes,
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedSnapshot,
  makeScriptedTransport,
} from './fixtures'

let spoolDirectory: string

beforeEach(async () => {
  spoolDirectory = await mkdtemp(join(tmpdir(), 'narsil-replica-spool-'))
})

afterEach(async () => {
  await rm(spoolDirectory, { recursive: true, force: true })
})

function transportThatHangsUpAfter(frames: readonly Uint8Array[]): NodeTransport {
  return {
    send: async () => {
      throw new Error('send is not part of a snapshot copy')
    },
    stream: async (_target: string, _message: TransportMessage, handler: (frame: Uint8Array) => void) => {
      for (const frame of frames) handler(frame)
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'the primary hung up')
    },
    listen: async () => () => {},
    shutdown: async () => {},
  }
}

function errorsOf(): { errors: unknown[]; onError: (error: unknown) => void } {
  const errors: unknown[] = []
  return { errors, onError: error => void errors.push(error) }
}

function reportedCause(code: string) {
  return expect.objectContaining({ details: expect.objectContaining({ innerCode: code }) })
}

describe('a replica that copies a whole index from its primary', () => {
  it('hands the restore every byte and keeps no spooled file afterwards', async () => {
    const engine = makeMockEngine()
    const { chunks, bytes } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 4 + 17)
    const deps = makeDeps(
      engine.engine,
      makeMockCoordinator({ title: 'string' }),
      makeScriptedTransport(chunks).transport,
      {
        snapshotSpoolDirectory: spoolDirectory,
      },
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(true)

    expect(engine.restoreCalls.map(call => call.data)).toEqual([bytes])
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('refuses bytes that differ from the checksum the primary announced, and deletes them', async () => {
    const engine = makeMockEngine()
    const original = new Uint8Array(5_000).fill(3)
    const altered = original.slice()
    altered[4_000] = 4
    const checksum = crc32(original)
    const frames = [
      buildSnapshotStartBytes('products', original.byteLength, checksum),
      buildSnapshotChunkBytes('products', 0, altered),
      buildSnapshotEndBytes('products', original.byteLength, checksum),
    ]
    const { errors, onError } = errorsOf()
    const deps = makeDeps(
      engine.engine,
      makeMockCoordinator({ title: 'string' }),
      makeScriptedTransport(frames).transport,
      {
        snapshotSpoolDirectory: spoolDirectory,
        onError,
      },
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(false)

    expect(engine.restoreCalls).toEqual([])
    expect(errors).toContainEqual(reportedCause(ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH))
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('deletes the part it received when the primary hangs up halfway', async () => {
    const engine = makeMockEngine()
    const { chunks } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 3)
    const { errors, onError } = errorsOf()
    const deps = makeDeps(
      engine.engine,
      makeMockCoordinator({ title: 'string' }),
      transportThatHangsUpAfter(chunks.slice(0, 3)),
      {
        snapshotSpoolDirectory: spoolDirectory,
        onError,
      },
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(false)

    expect(errors).toContainEqual(reportedCause(ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED))
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('deletes the copy when the restore fails', async () => {
    const engine = makeMockEngine({ restoreRejects: new Error('the disk is full') })
    const { chunks } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE + 1)
    const deps = makeDeps(
      engine.engine,
      makeMockCoordinator({ title: 'string' }),
      makeScriptedTransport(chunks).transport,
      {
        snapshotSpoolDirectory: spoolDirectory,
        onError: () => undefined,
      },
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(false)
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('reports a spool directory it cannot write to as a failed copy', async () => {
    const engine = makeMockEngine()
    const { chunks } = makeScriptedSnapshot('products', 2_048)
    const { errors, onError } = errorsOf()
    const deps = makeDeps(
      engine.engine,
      makeMockCoordinator({ title: 'string' }),
      makeScriptedTransport(chunks).transport,
      {
        snapshotSpoolDirectory: join(spoolDirectory, 'missing'),
        onError,
      },
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(false)
    expect(errors).toContainEqual(reportedCause(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED))
    expect(engine.restoreCalls).toEqual([])
  })
})

describe('a replica that copies one partition while the primary keeps writing', () => {
  function liveDeps(transport: NodeTransport, restored: Uint8Array[], onError: (error: unknown) => void) {
    const engine = makeMockEngine()
    let log: ReplicationLog = createReplicationLog(0)
    return makeDeps(engine.engine, makeMockCoordinator({ title: 'string' }), transport, {
      snapshotSpoolDirectory: spoolDirectory,
      onError,
      getReplicationLog: () => log,
      resetReplicationLog: (_indexName, partitionId, startSeqNo, lastPrimaryTerm) => {
        log = createReplicationLog(partitionId, { startSeqNo, lastPrimaryTerm })
      },
      applyReplicationEntry: async () => undefined,
      restoreReplicationPartition: async (_indexName, _partitionId, source) => {
        restored.push(source instanceof Uint8Array ? source : await bytesOf(source))
        engine.setHasIndex(true)
      },
    })
  }

  it('restores the partition from the spooled copy and then deletes it', async () => {
    const { chunks, bytes } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 2 + 5)
    const restored: Uint8Array[] = []
    const deps = liveDeps(
      makeScriptedTransport([...chunks, encode({ entries: [], isLast: true })]).transport,
      restored,
      () => undefined,
    )

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(true)

    expect(restored).toEqual([bytes])
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('deletes the part of the partition it received when the primary hangs up', async () => {
    const { chunks } = makeScriptedSnapshot('products', SNAPSHOT_CHUNK_SIZE * 2 + 5)
    const restored: Uint8Array[] = []
    const { errors, onError } = errorsOf()
    const deps = liveDeps(transportThatHangsUpAfter(chunks.slice(0, 2)), restored, onError)

    expect(await runBootstrapSync(createBootstrapSyncState(), 'products', 0, 'primary-node', deps)).toBe(false)

    expect(restored).toEqual([])
    expect(errors.every(error => error instanceof NarsilError)).toBe(true)
    expect(await readdir(spoolDirectory)).toEqual([])
  })
})
