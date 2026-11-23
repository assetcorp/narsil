import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransportMessage } from '../../../../distribution/transport/types'
import {
  createTestCluster,
  type HeldMessages,
  INDEX,
  type MessageRule,
  partitionAssignment,
  readCopy,
  type TestCluster,
  waitUntil,
} from './harness'

const VECTOR_SCHEMA = { title: 'string', amount: 'number', embedding: 'vector[3]' } as const
const ACKNOWLEDGED_WRITES = 20
const OVERWRITTEN_DOCUMENT = 'invoice-3'
const OBSERVATIONS_AFTER_ADMISSIONS = 15
const RESYNC_TIMEOUT_MS = 60_000
const CRC32_IEEE_POLYNOMIAL = 0xedb88320

const CRC32_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ CRC32_IEEE_POLYNOMIAL : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

interface SpoofedEntry {
  seqNo: number
  primaryTerm: number
  documentId: string
  document: Uint8Array
}

function entryMessage(spoofed: SpoofedEntry, primary: string): TransportMessage {
  const { seqNo, primaryTerm, documentId, document } = spoofed
  const checksum = crc32(encode([seqNo, primaryTerm, 'INDEX', 0, INDEX, documentId, document]))
  return {
    type: 'replication.entry',
    sourceId: primary,
    requestId: `spoofed-entry-${seqNo}`,
    payload: encode({
      entry: {
        seqNo,
        primaryTerm,
        operation: 'INDEX',
        partitionId: 0,
        indexName: INDEX,
        documentId,
        document,
        checksum,
      },
    }),
  }
}

function payloadOf(message: TransportMessage): Record<string, unknown> {
  return decode(message.payload) as Record<string, unknown>
}

function capturing(type: string, accept: (payload: Record<string, unknown>) => boolean, into: unknown[]): MessageRule {
  return (_target, message) => {
    if (message.type !== type) return false
    const payload = payloadOf(message)
    if (!accept(payload)) return false
    into.push(payload)
    return true
  }
}

describe('a replica copy that cannot apply an entry from its primary', () => {
  let cluster: TestCluster
  const holds: HeldMessages[] = []

  afterEach(async () => {
    for (const hold of holds.splice(0)) hold.release()
    await cluster.dispose()
  })

  it('empties itself, fences the admission in flight, and rejoins the in-sync set holding every acknowledged write', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a')
    await cluster.start('node-b')

    const admissions: Array<Record<string, unknown>> = []
    const syncsFromEmpty: Array<Record<string, unknown>> = []
    let copyBroken = false
    for (const nodeId of ['node-a', 'node-b']) {
      holds.push(cluster.transport(nodeId).holdWhen(capturing('replication.insync_add', () => true, admissions)))
      holds.push(
        cluster
          .transport(nodeId)
          .holdWhen(
            capturing('replication.sync_request', payload => copyBroken && payload.lastSeqNo === 0, syncsFromEmpty),
          ),
      )
    }
    const [admissionHoldA, syncHoldA, admissionHoldB, syncHoldB] = holds
    const controllerAdmissions = cluster.transport('controller').recordArrivalsWhen((_to, message) => {
      return message.type === 'replication.insync_add'
    })

    await cluster
      .node('controller')
      .createIndex(INDEX, { schema: VECTOR_SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const table = await waitUntil('the partition to have a primary and a replica', async () => {
      const current = await cluster.coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(current)
      return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.replicas.length === 1
        ? assignment
        : null
    })
    const primary = table.primary ?? ''
    const replica = table.replicas[0]

    const acknowledged = new Map<string, { title: string; amount: number }>()
    for (let i = 0; i < ACKNOWLEDGED_WRITES; i++) {
      const invoice = { title: `invoice ${i}`, amount: i * 7 }
      await cluster.node(primary).insert(INDEX, { ...invoice, embedding: [i, 1, 2] }, `invoice-${i}`)
      acknowledged.set(`invoice-${i}`, invoice)
    }
    await waitUntil('the primary to ask for the caught-up replica to join the in-sync set', () =>
      admissions.some(admission => admission.appliedSeqNo === ACKNOWLEDGED_WRITES),
    )
    copyBroken = true
    const reply = await cluster.probe.send(
      replica,
      entryMessage(
        {
          seqNo: ACKNOWLEDGED_WRITES + 1,
          primaryTerm: table.primaryTerm,
          documentId: OVERWRITTEN_DOCUMENT,
          document: encode({ title: 'invoice 3 with a short vector', amount: 0, embedding: [0.5, 0.5] }),
        },
        primary,
      ),
    )
    expect(reply.type).not.toBe('replication.ack')

    await waitUntil(
      'the replica to sync again from an empty copy',
      () => syncsFromEmpty.some(request => request.indexName === INDEX),
      RESYNC_TIMEOUT_MS,
    )

    const violations: string[] = []
    let observations = 0
    let observing = true
    const observer = (async () => {
      while (observing) {
        const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
        if (assignment?.inSyncSet.includes(replica) === true) {
          const held = await readCopy(cluster.probe, replica).catch(() => new Map())
          const missing = [...acknowledged.keys()].filter(id => !held.has(id))
          if (missing.length > 0) violations.push(`in sync without ${missing.join(', ')}`)
        }
        observations += 1
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    })()

    const heldAdmissions = admissionHoldA.count() + admissionHoldB.count()
    admissionHoldA.release()
    admissionHoldB.release()
    await waitUntil('the controller to receive every admission held in flight', () => {
      return controllerAdmissions.length >= heldAdmissions
    })
    const observedBeforeSync = observations
    await waitUntil('the observer to watch the table after the admissions', () => {
      return observations >= observedBeforeSync + OBSERVATIONS_AFTER_ADMISSIONS
    })
    syncHoldA.release()
    syncHoldB.release()

    const rejoined = await waitUntil(
      'the replica to rejoin the in-sync set with every acknowledged write',
      async () => {
        const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
        if (assignment?.inSyncSet.includes(replica) !== true) return null
        const held = await readCopy(cluster.probe, replica)
        return held.size === acknowledged.size ? held : null
      },
      RESYNC_TIMEOUT_MS,
    )
    observing = false
    await observer

    expect(violations).toEqual([])
    expect([...rejoined.keys()].sort()).toEqual([...acknowledged.keys()].sort())
    for (const [id, invoice] of acknowledged) expect(rejoined.get(id)).toMatchObject(invoice)
  }, 120_000)
})
