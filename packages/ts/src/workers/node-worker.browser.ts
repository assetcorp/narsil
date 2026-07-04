export type { NodeWorkerHandle } from './node-worker'

import type { NodeWorkerHandle } from './node-worker'

export async function spawnNodeWorker(_entryPoint: URL): Promise<NodeWorkerHandle | null> {
  return null
}

export async function isNodeMainThread(): Promise<boolean> {
  return true
}
