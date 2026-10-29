import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import { createTcpTransport } from '../../../distribution/transport/tcp'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, type FleetSettings, startFleet } from './fleet'
import type { LedgerDocument } from './oracle'
import { send } from './workload'

const HEAL_TIMEOUT_MS = 120_000
const HEAL_POLL_MS = 500
const COPY_PAGE_LIMIT = 10_000
const TABLE_POLL_MS = 1_000

export function clock(): string {
  return new Date().toISOString().slice(11, 23)
}

export interface StoredCopies {
  stored: Map<string, LedgerDocument>
  unequal: string[]
}

export interface ClusterUnderTest {
  readonly fleet: Fleet
  readonly etcd: EtcdMembers
  readonly coordinator: ClusterCoordinator
  untilHealed(indexName: string, partitionCount: number, minimumCopies: number, reason: string): Promise<void>
  readCopy(nodeId: string, indexName: string, partitionId: number): Promise<Map<string, LedgerDocument>>
  readStored(indexName: string): Promise<StoredCopies>
  replicationMetrics(): Promise<string>
  watchTable(indexName: string): () => Promise<string[]>
  close(): Promise<void>
}

export async function startClusterUnderTest(
  nodeCount: number,
  plain: boolean,
  settings: Omit<FleetSettings, 'keyPrefix' | 'fixedNodeIds'>,
): Promise<ClusterUnderTest> {
  const keyPrefix = `_narsil_faults_${randomUUID()}`
  const bundles: TlsBundles | null = plain ? null : await generateTlsBundles()
  const etcd = await startEtcdMembers(bundles)
  const fleet = await startFleet(nodeCount, etcd, bundles, { ...settings, keyPrefix, fixedNodeIds: plain })
  for (const node of fleet.nodes) await fleet.start(node.slot)
  const coordinator = await createEtcdCoordinator({
    endpoints: [...etcd.endpoints],
    keyPrefix,
    ...(bundles === null
      ? {}
      : {
          tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
          auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
        }),
  })
  const probe = createTcpTransport('fault-probe', {
    host: '127.0.0.1',
    port: 0,
    ...(bundles === null
      ? {}
      : { tls: { ca: bundles.serverBundle.ca, cert: bundles.serverBundle.cert, key: bundles.serverBundle.key } }),
  })

  async function healed(indexName: string, partitionCount: number, minimumCopies: number): Promise<boolean> {
    if (!fleet.nodes.every(node => node.running())) return false
    const running = new Set(fleet.nodes.map(node => node.nodeId()))
    const table = await coordinator.getAllocation(indexName).catch(() => null)
    if (table === null || table.assignments.size !== partitionCount) return false
    return [...table.assignments.values()].every(
      assignment =>
        assignment.state === 'ACTIVE' &&
        assignment.primary !== null &&
        running.has(assignment.primary) &&
        assignment.inSyncSet.length >= minimumCopies,
    )
  }

  async function replicationMetrics(): Promise<string> {
    const reports = await Promise.all(
      fleet.nodes.map(async node => {
        const reply = await send(node.base, 'GET', '/metrics', undefined, 5_000).catch((error: unknown) => ({
          text: String(error),
        }))
        const lines = reply.text.split('\n').filter(line => line.startsWith('narsil_') && !line.includes('_seconds'))
        return `slot ${node.slot} (${node.nodeId()}):\n${lines.join('\n')}`
      }),
    )
    return reports.join('\n')
  }

  async function readCopy(nodeId: string, indexName: string, partitionId: number) {
    const holder = fleet.nodes.find(node => node.nodeId() === nodeId)
    if (holder === undefined) throw new Error(`No running node holds the id ${nodeId}`)
    const response = await probe.send(holder.transportAddress, {
      type: 'query.list',
      sourceId: 'fault-probe',
      requestId: `fault-probe-${randomUUID()}`,
      payload: encode({
        indexName,
        partitionIds: [partitionId],
        cursor: null,
        limit: COPY_PAGE_LIMIT,
        filters: null,
        sort: null,
        fields: null,
      }),
    })
    const payload = decode(response.payload) as {
      entries?: Array<{ docId: string; document: { title?: unknown; version?: unknown } }>
      hasMore?: boolean
      message?: string
    }
    if (payload.entries === undefined) throw new Error(`${nodeId} answered ${response.type}: ${payload.message ?? ''}`)
    if (payload.hasMore === true) throw new Error(`${nodeId} holds more than ${COPY_PAGE_LIMIT} documents`)
    const copy = new Map<string, LedgerDocument>()
    for (const entry of payload.entries) {
      copy.set(entry.docId, { title: String(entry.document.title), version: Number(entry.document.version) })
    }
    return copy
  }

  function slotOf(nodeId: string | null): string {
    const node = fleet.nodes.find(candidate => candidate.nodeId() === nodeId)
    return node === undefined ? String(nodeId) : `s${node.slot}`
  }

  function watchTable(indexName: string): () => Promise<string[]> {
    const lines: string[] = []
    let last = ''
    let watching = true
    const polling = (async () => {
      while (watching) {
        const table = await coordinator.getAllocation(indexName).catch(() => null)
        const shown =
          table === null
            ? 'no table'
            : `v${table.version} ${[...table.assignments]
                .map(
                  ([partitionId, assignment]) =>
                    `p${partitionId} ${assignment.state} primary ${slotOf(assignment.primary)} t${assignment.primaryTerm} replicas [${assignment.replicas.map(slotOf).join(' ')}] in-sync [${assignment.inSyncSet.map(slotOf).join(' ')}]`,
                )
                .join('; ')}`
        if (shown !== last) lines.push(`${clock()} ${shown}`)
        last = shown
        await sleep(TABLE_POLL_MS)
      }
    })()
    return async () => {
      watching = false
      await polling
      return lines
    }
  }

  return {
    fleet,
    etcd,
    coordinator,
    replicationMetrics,
    readCopy,
    watchTable,
    async untilHealed(indexName, partitionCount, minimumCopies, reason) {
      const deadline = Date.now() + HEAL_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (await healed(indexName, partitionCount, minimumCopies)) return
        await sleep(HEAL_POLL_MS)
      }
      const table = await coordinator.getAllocation(indexName).catch(() => null)
      throw new Error(
        `The cluster did not heal within ${HEAL_TIMEOUT_MS} ms ${reason}: ${JSON.stringify([...(table?.assignments ?? [])])}\n${await replicationMetrics()}`,
      )
    },
    async readStored(indexName) {
      const table = await coordinator.getAllocation(indexName)
      const stored = new Map<string, LedgerDocument>()
      const unequal: string[] = []
      for (const [partitionId, assignment] of table?.assignments ?? []) {
        const holders = [assignment.primary ?? '', ...assignment.inSyncSet]
        const copies = await Promise.all(holders.map(holder => readCopy(holder, indexName, partitionId)))
        const primaryCopy = copies[0] ?? new Map<string, LedgerDocument>()
        for (let at = 1; at < copies.length; at++) {
          const copy = copies[at] ?? new Map<string, LedgerDocument>()
          const differing = [...new Set([...primaryCopy.keys(), ...copy.keys()])]
            .filter(docId => JSON.stringify(primaryCopy.get(docId)) !== JSON.stringify(copy.get(docId)))
            .sort()
          if (differing.length > 0) {
            const shown = differing
              .slice(0, 5)
              .map(
                docId =>
                  `${docId} primary ${primaryCopy.get(docId)?.version ?? 'absent'} copy ${copy.get(docId)?.version ?? 'absent'}`,
              )
            unequal.push(
              `partition ${partitionId}: ${holders[at]} differs from its primary ${holders[0]} on ${differing.length} of ${primaryCopy.size} documents: ${shown.join(', ')}`,
            )
          }
        }
        for (const [docId, document] of primaryCopy) stored.set(docId, document)
      }
      return { stored, unequal }
    },
    async close() {
      for (const node of fleet.nodes)
        console.log(`--- slot ${node.slot} (${node.nodeId()})\n${node.output().slice(-400_000)}`)
      await probe.shutdown().catch(() => {})
      await coordinator.shutdown().catch(() => {})
      await fleet.remove()
      await etcd.remove()
    },
  }
}
