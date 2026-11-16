import { ErrorCodes, NarsilError } from '#platform/optional-writes-host'
import type { ErrorCode } from '../../errors'
import type { BatchResult } from '../../types/results'
import type { ApplyMutation, MutationContext } from './context'

function isFailureThatShutdownCauses(code: string): boolean {
  return (
    code === ErrorCodes.INSTANCE_SHUT_DOWN ||
    code === ErrorCodes.INDEX_NOT_FOUND ||
    code === ErrorCodes.EMBEDDING_FAILED
  )
}

export function shutDownStarted(ctx: MutationContext): boolean {
  return ctx.abortController.signal.aborted
}

export function shutDownError(): NarsilError {
  return new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
}

export function causedByShutdown(ctx: MutationContext, err: unknown): boolean {
  const { signal } = ctx.abortController
  if (!signal.aborted) return false
  if (err === signal.reason) return true
  if (err instanceof NarsilError) return isFailureThatShutdownCauses(err.code)
  return err instanceof Error && err.name === 'AbortError'
}

export function batchFailureOf(ctx: MutationContext, err: unknown, fallbackCode: ErrorCode): NarsilError {
  if (causedByShutdown(ctx, err)) {
    return err instanceof NarsilError && err.code === ErrorCodes.INSTANCE_SHUT_DOWN ? err : shutDownError()
  }
  return err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err))
}

export function docIdOf(entry: { docId: string }): string {
  return entry.docId
}

export function failAsShutDown<T>(
  failed: BatchResult['failed'],
  entries: readonly T[],
  reportedDocIdOf: (entry: T) => string,
  start = 0,
  end = entries.length,
): void {
  if (start >= end) return
  const error = shutDownError()
  for (let i = start; i < end; i++) failed.push({ docId: reportedDocIdOf(entries[i]), error })
}

export function applyUnlessShutDown(ctx: MutationContext, apply: ApplyMutation): ApplyMutation {
  return () => {
    if (shutDownStarted(ctx)) throw shutDownError()
    return apply()
  }
}

export async function unlessShutDown(ctx: MutationContext, work: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await work()
  } catch (err) {
    if (!shutDownStarted(ctx)) throw err
  }
}
