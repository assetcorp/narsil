import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../distribution/coordinator'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { placementFaults } from './allocation-oracle'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import { connectCoordinator, createIndex, insertEntries, leaseHolder, searchCount, waitFor } from './mixed-cluster'

const TYPESCRIPT_SLOTS = [0, 1, 2]
const FIRST_RUST_CONTROLLER = 3
const SECOND_RUST_CONTROLLER = 4
const RUST_NODE_ON_ANOTHER_MAJOR = 5
const HEARTBEAT_TTL_SECONDS = 10
const LEASE_TTL_MS = 5_000
const STANDBY_RETRY_MS = 1_000
const NODE_LEFT_DELAY_MS = 2_000
const PARTITION_COUNT = 4
const REPLICATION_FACTOR = 1
const ENTRY_COUNT = 12
const TAKEOVER_MS = LEASE_TTL_MS + STANDBY_RETRY_MS + 10_000
const SETTLE_MS = 45_000
const FAILOVER_MS = HEARTBEAT_TTL_SECONDS * 1_000 + NODE_LEFT_DELAY_MS + 45_000
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined).each(['tcp', 'grpc'] as const)(
  'Rust controllers leading TypeScript data nodes over %s',
  carrier => {
    const keyPrefix = `_narsil_rust_controller_${randomUUID()}`
    let bundles: TlsBundles | null = null
    let etcd: EtcdMembers | null = null
    let fleet: Fleet | null = null
    let coordinator: ClusterCoordinator | null = null
    let dataNodeIds = new Set<string>()

    function started(): { fleet: Fleet; coordinator: ClusterCoordinator } {
      if (fleet === null || coordinator === null) throw new Error('The mixed cluster never started')
      return { fleet, coordinator }
    }

    function nodeIdOf(slot: number): string {
      return started().fleet.nodes[slot]?.nodeId() ?? ''
    }

    function baseOf(slot: number): string {
      return started().fleet.nodes[slot]?.base ?? ''
    }

    function rustNodeIds(): string[] {
      return [FIRST_RUST_CONTROLLER, SECOND_RUST_CONTROLLER].map(nodeIdOf)
    }

    async function settledPlacement(
      indexNames: readonly string[],
      balanced: boolean,
      departedNodeIds: readonly string[] = [],
      timeoutMs = SETTLE_MS,
    ): Promise<string[]> {
      const expectation = {
        partitionCount: PARTITION_COUNT,
        replicationFactor: REPLICATION_FACTOR,
        dataNodeIds: [...dataNodeIds],
        absentNodeIds: [...rustNodeIds(), ...departedNodeIds],
        balanced,
      }
      const readFaults = async (indexName: string) =>
        placementFaults(await started().coordinator.getAllocation(indexName), expectation).map(
          fault => `${indexName}: ${fault}`,
        )
      return waitFor(
        `The allocation of ${indexNames.join(' and ')} did not settle`,
        timeoutMs,
        async () => (await Promise.all(indexNames.map(readFaults))).flat(),
        faults => faults.length === 0,
      )
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      const rustController = { roles: ['coordinator', 'controller'] }
      fleet = await startFleet(6, etcd, bundles, {
        keyPrefix,
        partitionCount: PARTITION_COUNT,
        replicationFactor: REPLICATION_FACTOR,
        heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS,
        controllerLeaseTtlMs: LEASE_TTL_MS,
        standbyRetryMs: STANDBY_RETRY_MS,
        nodeLeftDelayMs: NODE_LEFT_DELAY_MS,
        waitForServingMs: 30_000,
        fixedNodeIds: false,
        transport: carrier,
        rustSlots: [FIRST_RUST_CONTROLLER, SECOND_RUST_CONTROLLER, RUST_NODE_ON_ANOTHER_MAJOR],
        slotSettings: {
          0: { roles: ['data', 'coordinator'] },
          1: { roles: ['data', 'coordinator'] },
          2: { roles: ['data', 'coordinator'] },
          [FIRST_RUST_CONTROLLER]: rustController,
          [SECOND_RUST_CONTROLLER]: rustController,
          [RUST_NODE_ON_ANOTHER_MAJOR]: { roles: ['coordinator'], version: '2.0' },
        },
      })
      await fleet.start(FIRST_RUST_CONTROLLER)
      coordinator = await connectCoordinator(etcd, bundles, keyPrefix)
      await waitFor(
        'The first Rust node took no lease',
        TAKEOVER_MS,
        () => leaseHolder(started().coordinator),
        holder => holder === nodeIdOf(FIRST_RUST_CONTROLLER),
      )
      await fleet.start(SECOND_RUST_CONTROLLER)
      for (const slot of TYPESCRIPT_SLOTS) await fleet.start(slot)
      dataNodeIds = new Set(TYPESCRIPT_SLOTS.map(nodeIdOf))
    }, 300_000)

    afterAll(async () => {
      await coordinator?.shutdown().catch(() => {})
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it('places every partition on the TypeScript data nodes, which bootstrap, admit replicas, and serve', async () => {
      expect(await leaseHolder(started().coordinator)).toBe(nodeIdOf(FIRST_RUST_CONTROLLER))
      await createIndex(baseOf(0), 'harbour')
      await insertEntries(baseOf(0), 'harbour', ENTRY_COUNT)

      expect(await settledPlacement(['harbour'], true)).toEqual([])
      for (const slot of TYPESCRIPT_SLOTS) expect(await searchCount(baseOf(slot), 'harbour')).toBe(ENTRY_COUNT)
    }, 120_000)

    it('refuses a node on another major specification version before it registers', async () => {
      const refused = await started()
        .fleet.start(RUST_NODE_ON_ANOTHER_MAJOR)
        .catch((error: unknown) => error)

      expect(refused).toBeInstanceOf(Error)
      const output = started().fleet.nodes[RUST_NODE_ON_ANOTHER_MAJOR]?.output() ?? ''
      expect(output).toContain('NODE_VERSION_INCOMPATIBLE')
      expect(output).toContain(`the active controller '${nodeIdOf(FIRST_RUST_CONTROLLER)}' follows 1.5`)
      const registered = (await started().coordinator.listNodes()).map(node => node.version)
      expect(registered).not.toContain('2.0')
    }, 120_000)

    it('hands the lease to the second Rust controller once the first dies, which places a new index', async () => {
      await started().fleet.kill(FIRST_RUST_CONTROLLER)
      await waitFor(
        'No controller took over',
        TAKEOVER_MS,
        () => leaseHolder(started().coordinator),
        holder => holder === nodeIdOf(SECOND_RUST_CONTROLLER),
      )

      await createIndex(baseOf(1), 'quay')
      await insertEntries(baseOf(1), 'quay', ENTRY_COUNT)
      expect(await settledPlacement(['quay'], true)).toEqual([])
      expect(await searchCount(baseOf(2), 'quay')).toBe(ENTRY_COUNT)
      expect(await searchCount(baseOf(2), 'harbour')).toBe(ENTRY_COUNT)
    }, 120_000)

    it(
      'moves the partitions of a dead data node to its in-sync replicas and copies them again',
      async () => {
        expect(await settledPlacement(['harbour', 'quay'], false)).toEqual([])
        const table = await started().coordinator.getAllocation('harbour')
        const leads = (slot: number) =>
          [...(table?.assignments.values() ?? [])].some(assignment => assignment.primary === nodeIdOf(slot))
        const victim = [1, 2].find(leads) ?? 1
        const victimId = nodeIdOf(victim)
        await started().fleet.kill(victim)
        dataNodeIds.delete(victimId)

        expect(await settledPlacement(['harbour', 'quay'], false, [victimId], FAILOVER_MS)).toEqual([])
        expect(await searchCount(baseOf(0), 'harbour')).toBe(ENTRY_COUNT)
        expect(await searchCount(baseOf(0), 'quay')).toBe(ENTRY_COUNT)
      },
      FAILOVER_MS + 30_000,
    )
  },
)
