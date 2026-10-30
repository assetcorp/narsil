import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../constants'

export const WINDOW_ENDED: unique symbol = Symbol('forward window ended')

export async function beforeWindowEnds<T>(work: Promise<T>, deadline: number): Promise<T | typeof WINDOW_ENDED> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const ended = new Promise<typeof WINDOW_ENDED>(resolve => {
    timer = setTimeout(() => resolve(WINDOW_ENDED), Math.max(0, deadline - Date.now()))
  })
  try {
    return await Promise.race([work, ended])
  } finally {
    clearTimeout(timer)
  }
}

export function windowEndedOutcome(indexName: string, docId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `This node stopped waiting for the primary of index '${indexName}' to answer the write to document '${docId}' once ${PRIMARY_CHANGE_RETRY_WINDOW_MS}ms had passed, so the write may or may not have taken effect. Read the document before you retry the write.`,
    { indexName, docId, reason: 'forward_window_ended' },
  )
}

export function interruptedOutcome(indexName: string, docId: string, error: unknown): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_OUTCOME_UNKNOWN,
    `The connection to the primary of index '${indexName}' failed after this node forwarded the write to document '${docId}', so the write may or may not have taken effect. Read the document before you retry the write.`,
    { indexName, docId, reason: 'forward_interrupted', originalError: describeError(error) },
  )
}
