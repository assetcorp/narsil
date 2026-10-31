import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import { TransportError, TransportErrorCodes } from '../transport/types'

export interface CopyRouting {
  nodeToPartitions: ReadonlyMap<string, readonly number[]>
  copiesByPartition: ReadonlyMap<number, readonly string[]>
}

export interface FailoverOutcome<T> {
  nodeId: string
  partitionIds: number[]
  status: 'success' | 'timeout' | 'failed'
  result: T | null
  error: unknown
}

const QUERY_REJECTION_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.SEARCH_INVALID_FIELD,
  ErrorCodes.SEARCH_INVALID_FILTER,
  ErrorCodes.SEARCH_INVALID_MODE,
  ErrorCodes.SEARCH_INVALID_CURSOR,
  ErrorCodes.SEARCH_RESULT_WINDOW_EXCEEDED,
  ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
  ErrorCodes.BM25_NOT_READY,
  ErrorCodes.VECTOR_DIMENSION_MISMATCH,
  ErrorCodes.CONFIG_INVALID,
])

const nodeRejections = new WeakSet<NarsilError>()

export function nodeRejectionOf(
  code: unknown,
  message: unknown,
  details?: Record<string, unknown>,
): NarsilError | null {
  if (typeof code !== 'string' || !QUERY_REJECTION_CODES.has(code)) return null
  const rejection = new NarsilError(code as ErrorCode, typeof message === 'string' ? message : code, details)
  nodeRejections.add(rejection)
  return rejection
}

export function markNodeRejection(error: NarsilError): NarsilError {
  nodeRejections.add(error)
  return error
}

export function rethrowAsRefusal(error: unknown): never {
  if (error instanceof NarsilError && QUERY_REJECTION_CODES.has(error.code)) markNodeRejection(error)
  throw error
}

export function isNodeRejection(error: unknown): boolean {
  return error instanceof NarsilError && nodeRejections.has(error)
}

export function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof TransportError) return error.code === TransportErrorCodes.TIMEOUT
  return error instanceof NarsilError && error.code === ErrorCodes.QUERY_NODE_TIMEOUT
}

function groupByNextCopy(
  routing: CopyRouting,
  failedNodeId: string,
  partitionIds: readonly number[],
): { retries: Map<string, number[]>; exhausted: number[] } {
  const retries = new Map<string, number[]>()
  const exhausted: number[] = []
  for (const partitionId of partitionIds) {
    const copies = routing.copiesByPartition.get(partitionId) ?? []
    const position = copies.indexOf(failedNodeId)
    const nextCopy = position === -1 ? undefined : copies[position + 1]
    if (nextCopy === undefined) {
      exhausted.push(partitionId)
      continue
    }
    const group = retries.get(nextCopy)
    if (group === undefined) retries.set(nextCopy, [partitionId])
    else group.push(partitionId)
  }
  return { retries, exhausted }
}

export async function sendWithFailover<T>(
  routing: CopyRouting,
  attempt: (nodeId: string, partitionIds: number[]) => Promise<T | null>,
): Promise<FailoverOutcome<T>[]> {
  async function tryCopy(nodeId: string, partitionIds: number[]): Promise<FailoverOutcome<T>[]> {
    let failure: FailoverOutcome<T>
    try {
      const result = await attempt(nodeId, partitionIds)
      if (result !== null) return [{ nodeId, partitionIds, status: 'success', result, error: null }]
      failure = { nodeId, partitionIds, status: 'timeout', result: null, error: null }
    } catch (error) {
      failure = { nodeId, partitionIds, status: isTimeoutFailure(error) ? 'timeout' : 'failed', result: null, error }
      if (isNodeRejection(error)) return [failure]
    }

    const { retries, exhausted } = groupByNextCopy(routing, nodeId, partitionIds)
    const retried = await Promise.all(Array.from(retries, ([nextNodeId, group]) => tryCopy(nextNodeId, group)))
    const outcomes = retried.flat()
    if (exhausted.length > 0) outcomes.push({ ...failure, partitionIds: exhausted })
    return outcomes
  }

  const first = await Promise.all(
    Array.from(routing.nodeToPartitions, ([nodeId, partitionIds]) => tryCopy(nodeId, [...partitionIds])),
  )
  return first.flat()
}

export async function sendToEveryPartition<T>(
  routing: CopyRouting,
  attempt: (nodeId: string, partitionIds: number[]) => Promise<T>,
): Promise<Array<{ nodeId: string; partitionIds: number[]; result: T }>> {
  const outcomes = await sendWithFailover(routing, attempt)
  const answered: Array<{ nodeId: string; partitionIds: number[]; result: T }> = []
  for (const outcome of outcomes) {
    if (outcome.status !== 'success' || outcome.result === null) {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
    }
    answered.push({ nodeId: outcome.nodeId, partitionIds: outcome.partitionIds, result: outcome.result })
  }
  return answered
}
