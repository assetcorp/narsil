import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Etcd3 } from 'etcd3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../distribution/coordinator'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { placementFaults } from './allocation-oracle'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import {
  connectCoordinator,
  connectRawEtcd,
  createIndex,
  insertEntries,
  leaseHolder,
  searchCount,
  waitFor,
  watchKey,
} from './mixed-cluster'
import { send } from './workload'

const TYPESCRIPT_CONTROLLER = 0
const TYPESCRIPT_DATA_SLOTS = [1, 2]
const RUST_CONTROLLER = 3
const HEARTBEAT_TTL_SECONDS = 10
const LEASE_TTL_MS = 5_000
const STANDBY_RETRY_MS = 1_000
const SOURCE_PARTITION_COUNT = 2
const TARGET_PARTITION_COUNT = 4
const REPLICATION_FACTOR = 1
const ENTRY_COUNT = 12
const TAKEOVER_MS = LEASE_TTL_MS + STANDBY_RETRY_MS + 10_000
const STANDBY_ROUNDS_WATCHED = 3
const SETTLE_MS = 45_000
const RECORD_WAIT_MS = 30_000
const CHANGE_FINISH_MS = 120_000
const INDEX_NAME = 'harbour'
const REBALANCE_RECORD_KEY = `_narsil/index/${INDEX_NAME}/rebalance`
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined)(
  'a Rust controller beside a TypeScript controller over gRPC',
  () => {
    const keyPrefix = `_narsil_rust_handover_${randomUUID()}`
    let bundles: TlsBundles | null = null
    let etcd: EtcdMembers | null = null
    let fleet: Fleet | null = null
    let coordinator: ClusterCoordinator | null = null
    let raw: Etcd3 | null = null

    function started(): { fleet: Fleet; coordinator: ClusterCoordinator; raw: Etcd3 } {
      if (fleet === null || coordinator === null || raw === null) throw new Error('The mixed cluster never started')
      return { fleet, coordinator, raw }
    }

    function nodeIdOf(slot: number): string {
      return started().fleet.nodes[slot]?.nodeId() ?? ''
    }

    function baseOf(slot: number): string {
      return started().fleet.nodes[slot]?.base ?? ''
    }

    function dataNodeIds(): string[] {
      return [TYPESCRIPT_CONTROLLER, ...TYPESCRIPT_DATA_SLOTS].map(nodeIdOf)
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      fleet = await startFleet(4, etcd, bundles, {
        keyPrefix,
        partitionCount: SOURCE_PARTITION_COUNT,
        replicationFactor: REPLICATION_FACTOR,
        heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS,
        controllerLeaseTtlMs: LEASE_TTL_MS,
        standbyRetryMs: STANDBY_RETRY_MS,
        waitForServingMs: 30_000,
        fixedNodeIds: false,
        transport: 'grpc',
        rustSlots: [RUST_CONTROLLER],
        slotSettings: {
          1: { roles: ['data', 'coordinator'] },
          2: { roles: ['data', 'coordinator'] },
          [RUST_CONTROLLER]: { roles: ['coordinator', 'controller'] },
        },
      })
      coordinator = await connectCoordinator(etcd, bundles, keyPrefix)
      raw = connectRawEtcd(etcd, bundles)
      await fleet.start(TYPESCRIPT_CONTROLLER)
      await waitFor(
        'The TypeScript controller took no lease',
        TAKEOVER_MS,
        () => leaseHolder(started().coordinator),
        holder => holder === nodeIdOf(TYPESCRIPT_CONTROLLER),
      )
      await fleet.start(RUST_CONTROLLER)
      for (const slot of TYPESCRIPT_DATA_SLOTS) await fleet.start(slot)
    }, 300_000)

    afterAll(async () => {
      raw?.close()
      await coordinator?.shutdown().catch(() => {})
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it('stands by while the TypeScript controller renews the lease, and the TypeScript controller places nothing on it', async () => {
      await sleep(STANDBY_RETRY_MS * STANDBY_ROUNDS_WATCHED)
      expect(await leaseHolder(started().coordinator)).toBe(nodeIdOf(TYPESCRIPT_CONTROLLER))
      const rust = (await started().coordinator.listNodes()).find(node => node.nodeId === nodeIdOf(RUST_CONTROLLER))
      expect(rust?.roles).toEqual(['coordinator', 'controller'])

      await createIndex(baseOf(1), INDEX_NAME)
      await insertEntries(baseOf(1), INDEX_NAME, ENTRY_COUNT)
      const expectation = {
        partitionCount: SOURCE_PARTITION_COUNT,
        replicationFactor: REPLICATION_FACTOR,
        dataNodeIds: dataNodeIds(),
        absentNodeIds: [nodeIdOf(RUST_CONTROLLER)],
        balanced: true,
      }
      const faults = await waitFor(
        'The allocation did not settle',
        SETTLE_MS,
        async () => placementFaults(await started().coordinator.getAllocation(INDEX_NAME), expectation),
        found => found.length === 0,
      )
      expect(faults).toEqual([])
    }, 120_000)

    it('finishes a partition count change that the TypeScript controller started, once it takes the lease', async () => {
      const watcher = await watchKey(started().raw, `${keyPrefix}/kv/${REBALANCE_RECORD_KEY}`)
      const recorded = new Promise<void>(resolve => {
        watcher.once('put', () => {
          started().fleet.cutCoordinator(TYPESCRIPT_CONTROLLER)
          resolve()
        })
      })
      const requested = await send(
        baseOf(1),
        'POST',
        `/indexes/${INDEX_NAME}/_rebalance`,
        { targetPartitionCount: TARGET_PARTITION_COUNT },
        20_000,
      )
      expect(requested.status, requested.text).toBe(202)
      await Promise.race([
        recorded,
        sleep(RECORD_WAIT_MS).then(() => {
          throw new Error('The TypeScript controller recorded no partition count change')
        }),
      ])
      await watcher.cancel()

      await waitFor(
        'The Rust controller took no lease',
        TAKEOVER_MS,
        () => leaseHolder(started().coordinator),
        holder => holder === nodeIdOf(RUST_CONTROLLER),
      )
      started().fleet.healCoordinator(TYPESCRIPT_CONTROLLER)
      const generation = await waitFor(
        'The partition count change did not finish',
        CHANGE_FINISH_MS,
        async () => {
          const remaining = await started().coordinator.get(REBALANCE_RECORD_KEY)
          const serving = (await started().coordinator.getAllocation(INDEX_NAME))?.generation ?? null
          return remaining === null || remaining.byteLength === 0 ? serving : null
        },
        serving => serving !== null,
      )
      expect(await leaseHolder(started().coordinator)).toBe(nodeIdOf(RUST_CONTROLLER))
      const swapped = await started().coordinator.getAllocation(generation ?? '')
      expect(swapped?.assignments.size).toBe(TARGET_PARTITION_COUNT)
      for (const slot of TYPESCRIPT_DATA_SLOTS) expect(await searchCount(baseOf(slot), INDEX_NAME)).toBe(ENTRY_COUNT)
    }, 300_000)
  },
)
