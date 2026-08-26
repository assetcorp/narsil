import type { AllocationTable, ClusterCoordinator, NodeRegistration } from '@delali/narsil/distribution'
import { createEtcdCoordinator } from '@delali/narsil/distribution/coordinator/etcd'
import { CONTROLLER_LEASE_KEY, ETCD_CLIENT_ENDPOINT, ETCD_KEY_PREFIX, INDEX_NAME, NODES } from '../topology'
import type { ClusterNodeRow, ClusterSnapshot, LinkRow, PartitionRow } from './cluster-types'
import { readProxyStates } from './toxiproxy'

type Listener = (snapshot: ClusterSnapshot) => void

const REFRESH_DEBOUNCE_MS = 120
const REFRESH_INTERVAL_MS = 2_000

interface ObserverState {
  coordinator: ClusterCoordinator
  listeners: Set<Listener>
  snapshot: ClusterSnapshot
  fingerprint: string
  debounce: ReturnType<typeof setTimeout> | null
  interval: ReturnType<typeof setInterval>
  unwatch: Array<() => void>
}

let observer: ObserverState | null = null
let starting: Promise<ObserverState> | null = null
let disposedWhileStarting = false

function linkRows(states: Map<string, boolean> | null): LinkRow[] {
  return NODES.flatMap(spec => [
    {
      nodeId: spec.nodeId,
      kind: 'coordinator' as const,
      proxyName: spec.etcdProxyName,
      enabled: states?.get(spec.etcdProxyName) ?? null,
    },
    {
      nodeId: spec.nodeId,
      kind: 'replication' as const,
      proxyName: spec.replicationProxyName,
      enabled: states?.get(spec.replicationProxyName) ?? null,
    },
  ])
}

function nodeRows(registrations: NodeRegistration[] | null): ClusterNodeRow[] {
  return NODES.map(spec => {
    const registration = registrations?.find(entry => entry.nodeId === spec.nodeId)
    return {
      nodeId: spec.nodeId,
      address: registration?.address ?? null,
      roles: registration === undefined ? [] : [...registration.roles],
      startedAt: registration?.startedAt ?? null,
      version: registration?.version ?? null,
      registered: registration !== undefined,
    }
  })
}

function partitionRows(allocation: AllocationTable | null): PartitionRow[] {
  if (allocation === null) {
    return []
  }
  const rows: PartitionRow[] = []
  for (const [partitionId, assignment] of allocation.assignments) {
    rows.push({
      partitionId,
      state: assignment.state,
      primary: assignment.primary,
      primaryTerm: assignment.primaryTerm,
      commitPoint: assignment.commitPoint,
      replicas: [...assignment.replicas],
      inSyncSet: [...assignment.inSyncSet],
    })
  }
  return rows.sort((a, b) => a.partitionId - b.partitionId)
}

function reasonOf(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === 'fulfilled') {
    return null
  }
  return result.reason instanceof Error ? result.reason.message : String(result.reason)
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

async function buildSnapshot(coordinator: ClusterCoordinator): Promise<ClusterSnapshot> {
  const [nodes, allocation, controller, proxies] = await Promise.allSettled([
    coordinator.listNodes(),
    coordinator.getAllocation(INDEX_NAME),
    coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY),
    readProxyStates(),
  ])

  const allocationTable = settledValue(allocation)

  return {
    updatedAt: new Date().toISOString(),
    indexName: INDEX_NAME,
    indexExists: allocationTable !== null && allocationTable.assignments.size > 0,
    allocationVersion: allocationTable?.version ?? null,
    replicationFactor: allocationTable?.replicationFactor ?? null,
    controllerNodeId: settledValue(controller),
    nodes: nodeRows(settledValue(nodes)),
    partitions: partitionRows(allocationTable),
    links: linkRows(settledValue(proxies)),
    coordinatorError: reasonOf(nodes) ?? reasonOf(allocation) ?? reasonOf(controller),
    faultInjectorError: reasonOf(proxies),
  }
}

function fingerprintOf(snapshot: ClusterSnapshot): string {
  const { updatedAt: _updatedAt, ...rest } = snapshot
  return JSON.stringify(rest)
}

async function refresh(state: ObserverState): Promise<void> {
  const snapshot = await buildSnapshot(state.coordinator)
  const fingerprint = fingerprintOf(snapshot)
  if (fingerprint === state.fingerprint) {
    return
  }
  state.snapshot = snapshot
  state.fingerprint = fingerprint
  for (const listener of state.listeners) {
    listener(snapshot)
  }
}

function scheduleRefresh(state: ObserverState): void {
  if (state.debounce !== null) {
    return
  }
  state.debounce = setTimeout(() => {
    state.debounce = null
    void refresh(state).catch(() => {})
  }, REFRESH_DEBOUNCE_MS)
}

async function createObserver(): Promise<ObserverState> {
  const coordinator = await createEtcdCoordinator({
    endpoints: [process.env.ETCD_ENDPOINT ?? ETCD_CLIENT_ENDPOINT],
    keyPrefix: ETCD_KEY_PREFIX,
  })

  const snapshot = await buildSnapshot(coordinator)
  const state: ObserverState = {
    coordinator,
    listeners: new Set<Listener>(),
    snapshot,
    fingerprint: fingerprintOf(snapshot),
    debounce: null,
    interval: setInterval(() => {
      void refresh(state).catch(() => {})
    }, REFRESH_INTERVAL_MS),
    unwatch: [],
  }

  const watchers = await Promise.allSettled([
    coordinator.watchNodes(() => scheduleRefresh(state)),
    coordinator.watchAllocation(() => scheduleRefresh(state)),
    coordinator.watchSchemas(() => scheduleRefresh(state)),
  ])
  for (const watcher of watchers) {
    if (watcher.status === 'fulfilled') {
      state.unwatch.push(watcher.value)
    }
  }

  return state
}

export async function ensureObserver(): Promise<ObserverState> {
  if (observer !== null) {
    return observer
  }
  if (starting === null) {
    disposedWhileStarting = false
    starting = createObserver()
      .then(async state => {
        if (disposedWhileStarting) {
          await shutDown(state)
          throw new Error('the cluster observer was disposed while it was starting')
        }
        observer = state
        return state
      })
      .finally(() => {
        starting = null
        disposedWhileStarting = false
      })
  }
  return starting
}

export async function currentSnapshot(): Promise<ClusterSnapshot> {
  const state = await ensureObserver()
  await refresh(state).catch(() => {})
  return state.snapshot
}

export async function subscribe(listener: Listener): Promise<() => void> {
  const state = await ensureObserver()
  state.listeners.add(listener)
  listener(state.snapshot)
  return () => {
    state.listeners.delete(listener)
  }
}

async function shutDown(state: ObserverState): Promise<void> {
  clearInterval(state.interval)
  if (state.debounce !== null) {
    clearTimeout(state.debounce)
    state.debounce = null
  }
  for (const unwatch of state.unwatch) {
    unwatch()
  }
  state.unwatch.length = 0
  state.listeners.clear()
  await state.coordinator.shutdown()
}

export async function disposeObserver(): Promise<void> {
  const state = observer
  observer = null

  const pending = starting
  if (pending !== null) {
    disposedWhileStarting = true
    await pending.catch(() => {})
  }

  if (state === null) {
    return
  }
  await shutDown(state)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeObserver()
  })
}
