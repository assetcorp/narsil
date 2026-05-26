import { encode } from '@msgpack/msgpack'
import { vi } from 'vitest'
import type { BootstrapSyncDeps } from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../../distribution/replication/snapshot-constants'
import {
  type NodeTransport,
  type ReplicationSnapshotHeader,
  type SnapshotChunkPayload,
  type SnapshotEndPayload,
  type SnapshotStartPayload,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../../distribution/transport/types'
import type { Narsil } from '../../../../narsil'
import { crc32 } from '../../../../serialization/crc32'

export type ScriptedChunk = Uint8Array

export interface MockEngineOptions {
  hasIndex?: boolean
  restoreRejects?: Error
  createIndexRejects?: Error
  statsSchema?: Record<string, unknown>
}

export interface MockEngineHandle {
  engine: Narsil
  restoreCalls: Array<{ indexName: string; data: Uint8Array }>
  createIndexCalls: string[]
  dropIndexCalls: string[]
  setHasIndex: (value: boolean) => void
}

export function makeMockEngine(options: MockEngineOptions = {}): MockEngineHandle {
  let hasIndex = options.hasIndex ?? false
  const restoreCalls: Array<{ indexName: string; data: Uint8Array }> = []
  const createIndexCalls: string[] = []
  const dropIndexCalls: string[] = []

  const statsSchema = options.statsSchema ?? { title: 'text' }
  const engine = {
    listIndexes: () => (hasIndex ? [{ name: 'products' }] : []),
    createIndex: async (name: string) => {
      if (options.createIndexRejects !== undefined) {
        throw options.createIndexRejects
      }
      hasIndex = true
      createIndexCalls.push(name)
    },
    dropIndex: async (name: string) => {
      hasIndex = false
      dropIndexCalls.push(name)
    },
    restore: async (indexName: string, data: Uint8Array) => {
      if (options.restoreRejects !== undefined) {
        throw options.restoreRejects
      }
      hasIndex = true
      restoreCalls.push({ indexName, data })
    },
    getStats: (_indexName: string) => ({ schema: statsSchema }),
  } as unknown as Narsil

  return {
    engine,
    restoreCalls,
    createIndexCalls,
    dropIndexCalls,
    setHasIndex: (value: boolean) => {
      hasIndex = value
    },
  }
}

export function makeMockCoordinator(schema: Record<string, string> | null): ClusterCoordinator {
  return {
    getSchema: vi.fn().mockResolvedValue(schema),
  } as unknown as ClusterCoordinator
}

export function buildSnapshotStartBytes(
  indexName: string,
  totalBytes: number,
  checksum: number,
  headerOverrides: Partial<ReplicationSnapshotHeader> = {},
): Uint8Array {
  const header: ReplicationSnapshotHeader = {
    lastSeqNo: 0,
    primaryTerm: 0,
    partitionId: 0,
    indexName,
    checksum,
    ...headerOverrides,
  }
  const payload: SnapshotStartPayload = { header, totalBytes }
  return encode(payload)
}

export function buildSnapshotChunkBytes(
  indexName: string,
  offset: number,
  data: Uint8Array,
  partitionId = 0,
): Uint8Array {
  const payload: SnapshotChunkPayload = { partitionId, indexName, offset, data }
  return encode(payload)
}

export function buildSnapshotEndBytes(indexName: string, totalBytes: number, checksum: number): Uint8Array {
  const payload: SnapshotEndPayload = { partitionId: 0, indexName, totalBytes, checksum }
  return encode(payload)
}

export function buildErrorEnvelopeBytes(code: string, message: string): Uint8Array {
  return encode({ error: true, code, message })
}

export function makeScriptedSnapshot(
  indexName: string,
  totalBytes: number,
): {
  chunks: ScriptedChunk[]
  bytes: Uint8Array
  checksum: number
} {
  const bytes = new Uint8Array(totalBytes)
  for (let i = 0; i < totalBytes; i++) {
    bytes[i] = (i * 31 + 7) % 256
  }
  const checksum = crc32(bytes)
  const chunks: ScriptedChunk[] = []
  chunks.push(buildSnapshotStartBytes(indexName, totalBytes, checksum))
  let offset = 0
  while (offset < totalBytes) {
    const end = Math.min(offset + SNAPSHOT_CHUNK_SIZE, totalBytes)
    chunks.push(buildSnapshotChunkBytes(indexName, offset, bytes.subarray(offset, end)))
    offset = end
  }
  chunks.push(buildSnapshotEndBytes(indexName, totalBytes, checksum))
  return { chunks, bytes, checksum }
}

export interface ScriptedTransport {
  transport: NodeTransport
  streamCalls: Array<{ target: string; message: TransportMessage }>
  setScript: (script: ScriptedChunk[] | 'reject' | Error) => void
  setPerTargetScript: (perTarget: Record<string, ScriptedChunk[] | Error>) => void
}

export function makeScriptedTransport(initial: ScriptedChunk[] | 'reject' | Error = []): ScriptedTransport {
  const streamCalls: Array<{ target: string; message: TransportMessage }> = []
  let script: ScriptedChunk[] | 'reject' | Error = initial
  let perTarget: Record<string, ScriptedChunk[] | Error> | null = null

  const transport: NodeTransport = {
    send: async () => {
      throw new Error('send not implemented in mock')
    },
    stream: async (target, message, handler) => {
      streamCalls.push({ target, message })
      if (perTarget !== null) {
        const entry = perTarget[target]
        if (entry instanceof Error) {
          throw entry
        }
        if (entry === undefined) {
          return
        }
        for (const chunk of entry) {
          handler(chunk)
        }
        return
      }
      if (script instanceof Error) {
        throw script
      }
      if (script === 'reject') {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'peer unavailable')
      }
      for (const chunk of script) {
        handler(chunk)
      }
    },
    listen: async () => () => {},
    shutdown: async () => {},
  }

  return {
    transport,
    streamCalls,
    setScript: value => {
      script = value
      perTarget = null
    },
    setPerTargetScript: value => {
      perTarget = value
    },
  }
}

export function makeDeps(
  engine: Narsil,
  coordinator: ClusterCoordinator,
  transport: NodeTransport,
  overrides: Partial<BootstrapSyncDeps> = {},
): BootstrapSyncDeps {
  return {
    engine,
    coordinator,
    transport,
    sourceNodeId: 'replica-node',
    resolveNodeTargets: async nodeId => [nodeId],
    ...overrides,
  }
}
