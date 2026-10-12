import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSnapshotSyncHandlerState,
  handleSnapshotSyncRequest,
} from '../../../distribution/cluster-node/snapshot-sync-handler'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { SNAPSHOT_CHUNK_SIZE } from '../../../distribution/replication/constants'
import { ReplicationMessageTypes, type TransportMessage } from '../../../distribution/transport/types'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { joinBytes } from '../../e2e/portability/archive-oracle'

const REPLICAS = ['replica-a', 'replica-b', 'replica-c']

let spoolDirectory: string

beforeEach(async () => {
  spoolDirectory = await mkdtemp(join(tmpdir(), 'narsil-sender-spool-'))
})

afterEach(async () => {
  await rm(spoolDirectory, { recursive: true, force: true })
})

function archiveBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 131 + 17) % 251
  return bytes
}

function streamOf(bytes: Uint8Array, piece: number, failAfter?: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && offset >= failAfter) {
        controller.error(new Error('the disk under the checkpoint went away'))
        return
      }
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + piece))
      offset += piece
    },
  })
}

function engineServing(stream: () => ReadableStream<Uint8Array>, delayMs = 0): Narsil {
  return {
    listIndexes: () => [{ name: 'products' }],
    snapshot: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return stream()
    }),
  } as unknown as Narsil
}

function coordinator(): ClusterCoordinator {
  const allocation: AllocationTable = {
    indexName: 'products',
    version: 1,
    replicationFactor: REPLICAS.length,
    assignments: new Map([
      [
        0,
        {
          primary: 'primary',
          replicas: REPLICAS,
          inSyncSet: ['primary', ...REPLICAS],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ]),
  }
  return { getAllocation: vi.fn().mockResolvedValue(allocation) } as unknown as ClusterCoordinator
}

function request(sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
    sourceId,
    requestId: `request-${sourceId}`,
    payload: encode({ indexName: 'products' }),
  }
}

function receivedBytes(responses: readonly TransportMessage[]): Uint8Array {
  return joinBytes(
    responses
      .filter(response => response.type === ReplicationMessageTypes.SNAPSHOT_CHUNK)
      .map(response => (decode(response.payload) as { data: Uint8Array }).data),
  )
}

describe('a primary that sends a snapshot to its replicas', () => {
  it('sends every byte of an archive several chunks long and leaves no spooled file behind', async () => {
    const source = archiveBytes(SNAPSHOT_CHUNK_SIZE * 3 + 4_321)
    const responses: TransportMessage[] = []
    const deps = {
      nodeId: 'primary',
      engine: engineServing(() => streamOf(source, 10_000)),
      coordinator: coordinator(),
      state: createSnapshotSyncHandlerState(),
      spoolDirectory,
    }

    await handleSnapshotSyncRequest(request('replica-a'), async response => void responses.push(response), deps)

    expect(responses.at(-1)?.type).toBe(ReplicationMessageTypes.SNAPSHOT_END)
    expect(receivedBytes(responses)).toEqual(source)
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('serves concurrent replicas from one spooled file until the last of them finishes', async () => {
    const source = archiveBytes(SNAPSHOT_CHUNK_SIZE * 2 + 99)
    const engine = engineServing(() => streamOf(source, 7_000), 30)
    const deps = {
      nodeId: 'primary',
      engine,
      coordinator: coordinator(),
      state: createSnapshotSyncHandlerState(4),
      spoolDirectory,
    }
    const healthy: TransportMessage[] = []
    const slow: TransportMessage[] = []
    let failingFrames = 0

    const outcomes = await Promise.allSettled([
      handleSnapshotSyncRequest(request('replica-a'), async response => void healthy.push(response), deps),
      handleSnapshotSyncRequest(
        request('replica-b'),
        async () => {
          failingFrames += 1
          if (failingFrames === 2) throw new Error('the replica hung up')
        },
        deps,
      ),
      handleSnapshotSyncRequest(
        request('replica-c'),
        async response => {
          await new Promise(resolve => setTimeout(resolve, 2))
          slow.push(response)
        },
        deps,
      ),
    ])

    expect(engine.snapshot).toHaveBeenCalledTimes(1)
    expect(outcomes[0].status).toBe('fulfilled')
    expect(receivedBytes(healthy)).toEqual(source)
    expect(receivedBytes(slow)).toEqual(source)
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('answers with an error and keeps no partial file when the archive fails halfway', async () => {
    const source = archiveBytes(SNAPSHOT_CHUNK_SIZE * 2)
    const responses: TransportMessage[] = []
    const deps = {
      nodeId: 'primary',
      engine: engineServing(() => streamOf(source, 8_192, SNAPSHOT_CHUNK_SIZE)),
      coordinator: coordinator(),
      state: createSnapshotSyncHandlerState(),
      spoolDirectory,
    }

    await handleSnapshotSyncRequest(request('replica-a'), async response => void responses.push(response), deps)

    expect(responses.map(response => response.type)).toEqual([`${ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST}.error`])
    expect((decode(responses[0].payload) as { code: string }).code).toBe(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED)
    expect(await readdir(spoolDirectory)).toEqual([])
  })

  it('answers with an error when the spool directory cannot hold the file', async () => {
    const responses: TransportMessage[] = []
    const deps = {
      nodeId: 'primary',
      engine: engineServing(() => streamOf(archiveBytes(1_000), 100)),
      coordinator: coordinator(),
      state: createSnapshotSyncHandlerState(),
      spoolDirectory: join(spoolDirectory, 'missing', 'directory'),
    }

    await handleSnapshotSyncRequest(request('replica-a'), async response => void responses.push(response), deps)

    expect((decode(responses[0].payload) as { code: string }).code).toBe(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED)
    expect(deps.state.active).toBe(0)
  })
})
