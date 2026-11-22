import { ErrorCodes, NarsilError } from '../../../errors'
import { CONTROLLER_LEASE_KEY } from '../../coordinator/constants'
import type { AllocationTable } from '../../coordinator/types'
import { sharesMajorVersion } from '../version'
import { type AllocationWatcherState, processInitialAllocations, startAllocationWatcher } from './allocation-watcher'
import { type RegistrationHeartbeatState, registrationToWrite, startRegistrationHeartbeat } from './heartbeat'
import type { NodeLifecycleConfig } from './types'

/**
 * Joins this node to the cluster, and returns once it is registered and following its partitions.
 *
 * The join fails with `NODE_VERSION_INCOMPATIBLE` before it writes anything where the active controller's
 * registration carries another major specification version.
 *
 * Where the coordinator still holds a live registration under this node's id, which a node that stopped without
 * leaving leaves behind, the node first waits for that registration's lease to expire, so that two registrations
 * never claim one id at once. Aborting `signal` ends that wait with `NODE_NOT_JOINED`, which is how a node that
 * shuts down mid-join stops waiting.
 *
 * The node then calls `beforeRegistration` where the caller gives one, and it registers only once that settles, so
 * that a node which lacks a copy that the cluster assigns to it can wait while the controller fails that copy over.
 * Where another process registers under the node's id during that call, the node waits for that registration to lapse
 * and calls `beforeRegistration` again, because what the cluster assigns to the id can change meanwhile.
 *
 * The node registers itself, starts the heartbeat that keeps the registration alive, bootstraps every partition the
 * allocation tables already assign to it, and then follows the allocation table for further changes. It reads the
 * table of every index the coordinator holds a schema for, so a node that restarts takes up the partitions it held
 * before its watch delivers the next change. A failure at any step reaches the caller, which stops the heartbeat
 * before it reports the node stopped.
 *
 * @param config - The lifecycle configuration, which names the coordinator, the transport, and this node.
 * @param watcherState - The allocation watcher state this call registers the watcher on.
 * @param heartbeatState - The heartbeat state this call starts the renewal timer on.
 * @param signal - Ends each wait before the registration once the node shuts down.
 * @returns A promise that settles once the node has joined.
 */
export async function joinCluster(
  config: NodeLifecycleConfig,
  watcherState: AllocationWatcherState,
  heartbeatState: RegistrationHeartbeatState,
  signal: AbortSignal,
): Promise<void> {
  await refuseControllerOnAnotherMajorVersion(config)
  await waitUntilFreeToRegister(config, signal)
  if (wasAborted(signal)) throw abortedJoin(config.registration.nodeId)
  await config.coordinator.registerNode(registrationToWrite(config))
  config.onRegistered?.()

  startRegistrationHeartbeat(heartbeatState, config)

  const initialTables = await loadInitialAllocations(config)

  processInitialAllocations(watcherState, config, initialTables)

  await startAllocationWatcher(watcherState, config)
}

async function refuseControllerOnAnotherMajorVersion(config: NodeLifecycleConfig): Promise<void> {
  const { nodeId, version } = config.registration
  const controllerNodeId = await config.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null || controllerNodeId === nodeId) return
  const nodes = await config.coordinator.listNodes()
  const controller = nodes.find(node => node.nodeId === controllerNodeId)
  if (controller === undefined || sharesMajorVersion(controller.version, version)) return
  throw new NarsilError(
    ErrorCodes.NODE_VERSION_INCOMPATIBLE,
    `Node '${nodeId}' follows specification version ${version}, and the active controller '${controllerNodeId}' follows ${String(controller.version)}, which has another major version`,
    { nodeId, version, controllerNodeId, controllerVersion: controller.version },
  )
}

async function waitUntilFreeToRegister(config: NodeLifecycleConfig, signal: AbortSignal): Promise<void> {
  await waitForEarlierRegistrationToLapse(config, signal)
  while (config.beforeRegistration !== undefined) {
    await config.beforeRegistration(signal)
    if (!(await holdsRegistration(config))) return
    await waitForEarlierRegistrationToLapse(config, signal)
  }
}

async function holdsRegistration(config: NodeLifecycleConfig): Promise<boolean> {
  const registered = await config.coordinator.listNodes()
  return registered.some(node => node.nodeId === config.registration.nodeId)
}

function abortedJoin(nodeId: string): NarsilError {
  return new NarsilError(ErrorCodes.NODE_NOT_JOINED, `Node '${nodeId}' shut down while it waited to register`, {
    nodeId,
  })
}

function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function waitForEarlierRegistrationToLapse(config: NodeLifecycleConfig, signal?: AbortSignal): Promise<void> {
  const nodeId = config.registration.nodeId
  if (wasAborted(signal)) throw abortedJoin(nodeId)
  let markLapsed: () => void = () => {}
  let markAborted: () => void = () => {}
  const lapsed = new Promise<void>((resolve, reject) => {
    markLapsed = resolve
    markAborted = () => reject(abortedJoin(nodeId))
  })
  lapsed.catch(() => {})
  signal?.addEventListener('abort', markAborted, { once: true })
  const unwatch = await config.coordinator.watchNodes(event => {
    if (event.type === 'node_left' && event.nodeId === nodeId) markLapsed()
  })
  try {
    if (await holdsRegistration(config)) await lapsed
    if (wasAborted(signal)) throw abortedJoin(nodeId)
  } finally {
    unwatch()
    signal?.removeEventListener('abort', markAborted)
  }
}

async function loadInitialAllocations(config: NodeLifecycleConfig): Promise<AllocationTable[]> {
  const tables: AllocationTable[] = []
  const indexNames = new Set([...config.knownIndexNames, ...(await config.coordinator.listSchemas())])

  for (const indexName of indexNames) {
    const table = await config.coordinator.getAllocation(indexName)
    if (table !== null) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Removes this node's registration from the coordinator, so that the controller reallocates its partitions.
 *
 * A caller stops the registration heartbeat and waits for the renewal in flight before it calls this, because a
 * renewal that lands afterwards would write the registration back.
 *
 * @param config - The lifecycle configuration, which names the coordinator and this node.
 * @returns A promise that settles once the coordinator has dropped the registration.
 */
export async function leaveCluster(config: NodeLifecycleConfig): Promise<void> {
  await config.coordinator.deregisterNode(config.registration.nodeId)
}
