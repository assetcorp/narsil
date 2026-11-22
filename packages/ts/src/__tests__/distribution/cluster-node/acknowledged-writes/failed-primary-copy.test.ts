import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createForwardBatchMessage, createForwardMessage } from '../../../../distribution/replication/codec'
import type { ForwardBatchOperation, ForwardPayload } from '../../../../distribution/transport/types'
import { encodeDocument } from '../../../../serialization/document-encoding'
import { createTestCluster, INDEX, ofType, SCHEMA, type TestCluster, waitForCopies } from './harness'

const ROUTER = 'router'
const PRIMARY = 'node-a'
const REPLICA = 'node-b'
const REPLICATION_TIMEOUT_MS = 1_000
const ONE_RECORD_PER_SEGMENT_BYTES = 64
const SEGMENT_NAME_DIGITS = 16
const SEGMENT_NAME = /^\d{16}$/
const NO_CHECKPOINT_MS = 3_600_000
const NO_CHECKPOINT_MUTATIONS = 1_000_000
const CLEANUP_RETRIES = 10
const CLEANUP_RETRY_MS = 100

interface Answer {
  code: string
  reason?: unknown
}

function answerOf(payload: Record<string, unknown>): Answer {
  if (payload.success === true) return { code: 'accepted' }
  const details = (payload.details ?? payload.errorDetails) as Record<string, unknown> | null | undefined
  const answer: Answer = { code: String(payload.code ?? payload.errorCode) }
  if (details?.reason !== undefined) answer.reason = details.reason
  return answer
}

function termEnded(): Answer {
  return { code: 'REPLICATION_OUTCOME_UNKNOWN', reason: 'term_ended' }
}

function ledgerEntry(title: string, amount: number): Uint8Array {
  return encodeDocument({ title, amount })
}

describe('a primary whose copy fails while it writes', () => {
  let cluster: TestCluster | undefined
  let directory: string | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_MS })
    }
    directory = undefined
  })

  async function startPrimary(withReplica: boolean): Promise<{ cluster: TestCluster; logDirectory: string }> {
    const logDirectory = await mkdtemp(join(tmpdir(), 'narsil-failed-primary-copy-'))
    directory = logDirectory
    const started = await createTestCluster()
    cluster = started
    const timeouts = { replicationTimeout: REPLICATION_TIMEOUT_MS }
    await started.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false, timeouts })
    await started.start(PRIMARY, {
      durable: false,
      timeouts,
      engine: {
        durability: {
          directory: logDirectory,
          mode: 'sync',
          segmentMaxBytes: ONE_RECORD_PER_SEGMENT_BYTES,
          checkpointIntervalMs: NO_CHECKPOINT_MS,
          checkpointMutationThreshold: NO_CHECKPOINT_MUTATIONS,
        },
      },
    })
    await started
      .node(ROUTER)
      .createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: withReplica ? 1 : 0 })
    await waitForCopies(started.coordinator, PRIMARY, [])
    if (withReplica) {
      await started.start(REPLICA, { durable: false, timeouts })
      await waitForCopies(started.coordinator, PRIMARY, [REPLICA])
    }
    for (let at = 1; at <= 3; at++) {
      await started.node(ROUTER).insert(INDEX, { title: `opening ${at}`, amount: at }, `account-${at}`)
    }
    return { cluster: started, logDirectory }
  }

  async function blockLogSegmentsAfter(logDirectory: string, writesBefore: number): Promise<void> {
    const log = join(logDirectory, INDEX, 'wal', '0')
    const segments = (await readdir(log)).filter(name => SEGMENT_NAME.test(name)).sort()
    expect(segments.at(-1)).toBe(String(writesBefore).padStart(SEGMENT_NAME_DIGITS, '0'))
    for (let seqNo = writesBefore + 1; seqNo <= writesBefore + 8; seqNo++) {
      await mkdir(join(log, String(seqNo).padStart(SEGMENT_NAME_DIGITS, '0')))
    }
  }

  async function blockLogSegment(logDirectory: string, seqNo: number): Promise<void> {
    await mkdir(join(logDirectory, INDEX, 'wal', '0', String(seqNo).padStart(SEGMENT_NAME_DIGITS, '0')))
  }

  async function forward(target: TestCluster, payload: Omit<ForwardPayload, 'indexName'>): Promise<Answer> {
    const response = await target.probe.send(
      PRIMARY,
      createForwardMessage({ indexName: INDEX, ...payload }, 'copy-reader'),
    )
    return answerOf(decode(response.payload) as Record<string, unknown>)
  }

  async function forwardBatch(target: TestCluster, operations: ForwardBatchOperation[]): Promise<Answer[]> {
    const response = await target.probe.send(
      PRIMARY,
      createForwardBatchMessage({ indexName: INDEX, operations }, 'copy-reader'),
    )
    const payload = decode(response.payload) as { results?: Array<Record<string, unknown>> }
    return (payload.results ?? []).map(answerOf)
  }

  function cutOffReplica(target: TestCluster): void {
    const transport = target.transport(PRIMARY)
    transport.dropWhen(
      (to, message) =>
        to === REPLICA && (message.type === 'replication.entry' || message.type === 'replication.entry_batch'),
    )
    transport.dropWhen(ofType('replication.insync_remove'))
  }

  it('answers outcome unknown for a write whose own log append failed, and not-primary for the writes after it', async () => {
    const started = await startPrimary(false)
    await blockLogSegmentsAfter(started.logDirectory, 3)

    expect(
      await forward(started.cluster, {
        documentId: 'account-9',
        operation: 'insert',
        document: ledgerEntry('in doubt', 9),
        updateFields: null,
      }),
    ).toEqual(termEnded())
    expect(
      await forward(started.cluster, {
        documentId: 'account-10',
        operation: 'insert',
        document: ledgerEntry('after the failure', 10),
        updateFields: null,
      }),
    ).toEqual({ code: 'PARTITION_NOT_PRIMARY' })
  }, 60_000)

  it('answers outcome unknown for the batch write whose log append failed, and not-primary for the rest', async () => {
    const started = await startPrimary(false)
    await blockLogSegmentsAfter(started.logDirectory, 3)

    expect(
      await forwardBatch(started.cluster, [
        { documentId: 'account-9', operation: 'insert', document: ledgerEntry('in doubt', 9), updateFields: null },
        {
          documentId: 'account-10',
          operation: 'insert',
          document: ledgerEntry('never written', 10),
          updateFields: null,
        },
        {
          documentId: 'account-11',
          operation: 'insert',
          document: ledgerEntry('never written', 11),
          updateFields: null,
        },
      ]),
    ).toEqual([termEnded(), { code: 'PARTITION_NOT_PRIMARY' }, { code: 'PARTITION_NOT_PRIMARY' }])
  }, 60_000)

  it('answers outcome unknown for a single write whose compensating log append failed', async () => {
    const started = await startPrimary(true)
    await blockLogSegment(started.logDirectory, 5)
    cutOffReplica(started.cluster)

    expect(
      await forward(started.cluster, {
        documentId: 'account-2',
        operation: 'update',
        document: ledgerEntry('in doubt', 20),
        updateFields: null,
      }),
    ).toEqual(termEnded())
  }, 60_000)

  it('answers outcome unknown for each batch write whose rollback could not be logged', async () => {
    const started = await startPrimary(true)
    await blockLogSegment(started.logDirectory, 6)
    cutOffReplica(started.cluster)

    expect(
      await forwardBatch(started.cluster, [
        { documentId: 'account-1', operation: 'remove', document: null, updateFields: null },
        { documentId: 'account-2', operation: 'remove', document: null, updateFields: null },
      ]),
    ).toEqual([termEnded(), termEnded()])
  }, 60_000)
})
