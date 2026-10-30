import type { NodeTransport, TransportMessage } from '../transport/types'
import type { QueryRoutingDeps } from './types'

export async function resolveTargets(
  nodeId: string,
  deps: Pick<QueryRoutingDeps, 'resolveNodeTargets'>,
): Promise<string[]> {
  if (deps.resolveNodeTargets === undefined) {
    return [nodeId]
  }
  const targets = await deps.resolveNodeTargets(nodeId)
  return targets.length > 0 ? targets : [nodeId]
}

export async function sendToFirstReachableTarget(
  transport: NodeTransport,
  targets: string[],
  message: TransportMessage,
): Promise<TransportMessage> {
  let lastError: unknown
  for (const target of targets) {
    try {
      return await transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
