export type { NodeWorkerHandle } from './node-worker'

import type { NodeWorkerHandle } from './node-worker'
import type { WorkerResourceLimits } from './resource-limits'

export async function spawnNodeWorker(
  _entryPoint: URL,
  _resourceLimits?: WorkerResourceLimits,
): Promise<NodeWorkerHandle | null> {
  return null
}

export async function isNodeMainThread(): Promise<boolean> {
  return true
}
