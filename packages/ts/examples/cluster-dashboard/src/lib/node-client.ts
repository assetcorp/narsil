import { createNarsilClient, type NarsilClient, NarsilError } from '@delali/narsil/client'
import { nodeHttpUrlOf, nodeSpecOf } from '../topology'

const REQUEST_TIMEOUT_MS = 15_000
const UNKNOWN_FAILURE_CODE = 'UNKNOWN_ERROR'

const clientsByNodeId = new Map<string, NarsilClient>()

export interface NodeFailure {
  code: string
  message: string
}

/**
 * Gives the Narsil client that talks to one node of the cluster, building it on the first call.
 *
 * Every call the dashboard makes to a node goes through this client, so the timeout, the error codes, and the
 * response shapes are the ones the package publishes.
 *
 * @param nodeId - The node to reach, which must be one the topology names.
 * @returns The client bound to that node's HTTP address.
 */
export function nodeClient(nodeId: string): NarsilClient {
  const existing = clientsByNodeId.get(nodeId)
  if (existing !== undefined) {
    return existing
  }
  const client = createNarsilClient({
    url: nodeHttpUrlOf(nodeSpecOf(nodeId)),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  clientsByNodeId.set(nodeId, client)
  return client
}

/**
 * Reads the code and the message out of a failed call, so a panel can show what the node answered.
 *
 * The client raises a {@link NarsilError} for a refusal the server sent and for a request that never reached it, so
 * the code names the reason in both cases.
 *
 * @param error - Whatever the failed call threw.
 * @returns The code and the message to show.
 */
export function failureOf(error: unknown): NodeFailure {
  if (error instanceof NarsilError) {
    return { code: error.code, message: error.message }
  }
  return { code: UNKNOWN_FAILURE_CODE, message: error instanceof Error ? error.message : String(error) }
}
