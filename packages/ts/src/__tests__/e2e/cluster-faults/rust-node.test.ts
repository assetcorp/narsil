import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { Etcd3 } from 'etcd3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import type { NodeRegistration } from '../../../distribution/coordinator/types/node'
import {
  type NodeTransport,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../distribution/transport'
import { createGrpcTransport } from '../../../distribution/transport/grpc'
import { createTcpTransport } from '../../../distribution/transport/tcp'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import { send } from './workload'

const TYPESCRIPT_SLOT = 0
const RUST_SLOT = 1
const HEARTBEAT_TTL_SECONDS = 10
const INDEX_NAME = 'harbour'
const DOCUMENT_COUNT = 3
const PROBE_SNAPSHOT_TIMEOUT_MS = 60_000
const PROMPT_FAILURE_MS = 5_000
const LEASE_EXPIRY_SLACK_MS = 10_000
const SEARCH_SETTLE_MS = 30_000
const POLL_MS = 200
const PING_TIMESTAMP = 1_700_000_000_000
const REGISTRATION_FIELDS = ['nodeId', 'address', 'roles', 'capacity', 'startedAt', 'version']
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

interface Refusal {
  error: boolean
  code: string
  message: string
  details?: Record<string, unknown>
}

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined).each(['tcp', 'grpc'] as const)(
  'a Rust node beside a TypeScript node over %s',
  carrier => {
    const keyPrefix = `_narsil_rust_node_${randomUUID()}`
    let bundles: TlsBundles | null = null
    let etcd: EtcdMembers | null = null
    let fleet: Fleet | null = null
    let coordinator: ClusterCoordinator | null = null
    let probe: NodeTransport | null = null
    let raw: Etcd3 | null = null

    function started(): { fleet: Fleet; coordinator: ClusterCoordinator; probe: NodeTransport; raw: Etcd3 } {
      if (fleet === null || coordinator === null || probe === null || raw === null) {
        throw new Error('The mixed cluster never started')
      }
      return { fleet, coordinator, probe, raw }
    }

    function rustNodeId(): string {
      return started().fleet.nodes[RUST_SLOT]?.nodeId() ?? ''
    }

    async function rustRegistration(): Promise<NodeRegistration | undefined> {
      const nodeId = rustNodeId()
      return (await started().coordinator.listNodes()).find(node => node.nodeId === nodeId)
    }

    async function rustAddress(): Promise<string> {
      const registration = await rustRegistration()
      if (registration === undefined) throw new Error('The Rust node holds no registration')
      return registration.address
    }

    function request(type: string, payload: Uint8Array): TransportMessage {
      return { type, sourceId: 'rust-probe', requestId: randomUUID(), payload }
    }

    async function refusalOf(type: string, payload: Uint8Array): Promise<Refusal> {
      const reply = await started().probe.send(await rustAddress(), request(type, payload))
      expect(reply.type).toBe(`${type}.error`)
      expect(reply.sourceId).toBe(rustNodeId())
      return decode(reply.payload) as Refusal
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      fleet = await startFleet(2, etcd, bundles, {
        keyPrefix,
        partitionCount: 2,
        replicationFactor: 1,
        heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS,
        controllerLeaseTtlMs: 5_000,
        standbyRetryMs: 1_000,
        waitForServingMs: 30_000,
        fixedNodeIds: false,
        transport: carrier,
        rustSlots: [RUST_SLOT],
      })
      await fleet.start(RUST_SLOT)
      await fleet.start(TYPESCRIPT_SLOT)
      const etcdSecurity =
        bundles === null
          ? {}
          : {
              tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
              auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
            }
      coordinator = await createEtcdCoordinator({ endpoints: [...etcd.endpoints], keyPrefix, ...etcdSecurity })
      const probeConfig = {
        host: '127.0.0.1',
        port: 0,
        snapshotTimeout: PROBE_SNAPSHOT_TIMEOUT_MS,
        ...(bundles === null
          ? {}
          : { tls: { ca: bundles.serverBundle.ca, cert: bundles.serverBundle.cert, key: bundles.serverBundle.key } }),
      }
      probe =
        carrier === 'grpc'
          ? await createGrpcTransport('rust-probe', probeConfig)
          : createTcpTransport('rust-probe', probeConfig)
      raw = new Etcd3({
        hosts: [...etcd.endpoints],
        ...(bundles === null
          ? {}
          : {
              credentials: {
                rootCertificate: Buffer.from(bundles.serverBundle.ca),
                certChain: Buffer.from(bundles.clientBundle.cert),
                privateKey: Buffer.from(bundles.clientBundle.key),
              },
              auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
            }),
      })
    }, 300_000)

    afterAll(async () => {
      await probe?.shutdown().catch(() => {})
      await coordinator?.shutdown().catch(() => {})
      raw?.close()
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it('registers the record and start time that a TypeScript node reads, under one lease', async () => {
      const registration = await rustRegistration()
      expect(registration).toMatchObject({
        nodeId: rustNodeId(),
        roles: ['coordinator'],
        version: '1.5',
        capacity: { memoryBytes: 8_000_000_000, cpuCores: 4 },
      })
      expect(registration?.address).toMatch(/^127\.0\.0\.1:\d+$/)
      expect(new Date(registration?.startedAt ?? '').toISOString()).toBe(registration?.startedAt)

      const typescriptNodeId = started().fleet.nodes[TYPESCRIPT_SLOT]?.nodeId() ?? ''
      const stored = (await started().raw.get(`${keyPrefix}/nodes/${rustNodeId()}`).exec()).kvs[0]
      const written = (await started().raw.get(`${keyPrefix}/nodes/${typescriptNodeId}`).exec()).kvs[0]
      const startedAt = (await started().raw.get(`${keyPrefix}/node-started-at/${rustNodeId()}`).exec()).kvs[0]
      if (stored === undefined || written === undefined || startedAt === undefined) {
        throw new Error('etcd holds no record of one of the two nodes')
      }
      const record = decode(stored.value) as Record<string, unknown>
      const typescriptRecord = decode(written.value) as Record<string, unknown>
      expect(Object.keys(record)).toEqual(REGISTRATION_FIELDS)
      expect(Object.keys(typescriptRecord).filter(key => key !== 'memory')).toEqual(Object.keys(record))
      expect(Object.keys(record.capacity as Record<string, unknown>)).toEqual(
        Object.keys(typescriptRecord.capacity as Record<string, unknown>),
      )
      expect((record.capacity as Record<string, unknown>).diskBytes).toBeNull()
      expect(startedAt.value.toString('utf8')).toBe(registration?.startedAt)
      expect(stored.lease).not.toBe('0')
      expect(startedAt.lease).toBe(stored.lease)
    })

    it('answers cluster.ping through its registered address', async () => {
      const ping = request('cluster.ping', encode({ timestamp: PING_TIMESTAMP }))
      const before = Date.now()
      const reply = await started().probe.send(await rustAddress(), ping)
      const after = Date.now()

      expect(reply).toMatchObject({ type: 'cluster.pong', sourceId: rustNodeId(), requestId: ping.requestId })
      const pong = decode(reply.payload) as { timestamp: number; respondedAt: number }
      expect(Object.keys(pong)).toEqual(['timestamp', 'respondedAt'])
      expect(pong.timestamp).toBe(PING_TIMESTAMP)
      expect(pong.respondedAt).toBeGreaterThanOrEqual(before)
      expect(pong.respondedAt).toBeLessThanOrEqual(after)
    })

    it('refuses a bad timestamp, a payload that is not MessagePack, and every request that it cannot serve yet', async () => {
      for (const payload of [{ timestamp: -1 }, { timestamp: 1.5 }, { timestamp: 'soon' }, {}]) {
        expect((await refusalOf('cluster.ping', encode(payload))).code).toBe('CONFIG_INVALID')
      }
      const undecodable = await refusalOf('cluster.ping', new Uint8Array([0xc1]))
      expect(undecodable).toMatchObject({ error: true, code: 'TRANSPORT_DECODE_FAILED' })
      expect(undecodable.details?.messageType).toBe('cluster.ping')
      const unserved = await refusalOf('query.search', encode({ indexName: INDEX_NAME }))
      expect(unserved).toMatchObject({ error: true, code: 'NODE_NOT_READY', details: { nodeId: rustNodeId() } })
    })

    it('fails a stream at once when the node cannot decode the request', async () => {
      const malformed = { ...request('cluster.ping', new Uint8Array()), payload: 'not bytes' as unknown as Uint8Array }
      const before = Date.now()
      const failure = await started()
        .probe.stream(await rustAddress(), malformed, () => {})
        .catch((thrown: unknown) => thrown)

      expect(failure).toBeInstanceOf(TransportError)
      expect((failure as TransportError).code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
      expect(Date.now() - before).toBeLessThan(PROMPT_FAILURE_MS)
    })

    it('leaves the TypeScript node free to create, fill, and search an index that places nothing on it', async () => {
      const base = started().fleet.nodes[TYPESCRIPT_SLOT]?.base ?? ''
      const created = await send(
        base,
        'POST',
        '/indexes',
        { name: INDEX_NAME, config: { schema: { title: 'string' } } },
        60_000,
      )
      expect(created.status, created.text).toBe(201)
      for (let at = 0; at < DOCUMENT_COUNT; at++) {
        const inserted = await send(
          base,
          'POST',
          `/indexes/${INDEX_NAME}/documents`,
          { id: `entry-${at}`, document: { title: `ledger entry ${at}` } },
          20_000,
        )
        expect(inserted.status, inserted.text).toBeLessThan(300)
      }
      const deadline = Date.now() + SEARCH_SETTLE_MS
      let count = -1
      while (count !== DOCUMENT_COUNT && Date.now() < deadline) {
        const found = await send(base, 'POST', `/indexes/${INDEX_NAME}/search`, { term: 'ledger', limit: 10 }, 20_000)
        count = found.status === 200 ? Number((JSON.parse(found.text) as { count?: unknown }).count) : -1
        if (count !== DOCUMENT_COUNT) await sleep(POLL_MS)
      }
      expect(count).toBe(DOCUMENT_COUNT)

      const table = await started().coordinator.getAllocation(INDEX_NAME)
      const holders = [...(table?.assignments.values() ?? [])].flatMap(assignment =>
        assignment.primary === null ? [...assignment.replicas] : [assignment.primary, ...assignment.replicas],
      )
      expect(holders.length).toBeGreaterThan(0)
      expect(holders).not.toContain(rustNodeId())
    })

    it('drops out of etcd once its lease lapses after a kill, and registers again under the same id on restart', async () => {
      const nodeId = rustNodeId()
      await started().fleet.kill(RUST_SLOT)
      const killedAt = Date.now()
      while ((await rustRegistration()) !== undefined) {
        expect(Date.now() - killedAt).toBeLessThan(HEARTBEAT_TTL_SECONDS * 1_000 + LEASE_EXPIRY_SLACK_MS)
        await sleep(POLL_MS)
      }

      await started().fleet.start(RUST_SLOT)
      expect(rustNodeId()).toBe(nodeId)
      expect((await rustRegistration())?.nodeId).toBe(nodeId)
    }, 60_000)

    it('removes its registration as it stops', async () => {
      expect(await rustRegistration()).toBeDefined()
      const nodeId = rustNodeId()
      await started().fleet.stopAll()

      const left = (await started().coordinator.listNodes()).map(node => node.nodeId)
      expect(left).not.toContain(nodeId)
    }, 60_000)
  },
)
