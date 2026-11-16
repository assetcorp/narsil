import { ErrorCodes, NarsilError, providedDocId } from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { ApplyMutation, MutationContext } from './context'

export function batchStopped(ctx: MutationContext): boolean {
  return ctx.abortController.signal.aborted
}

export function shutDownError(): NarsilError {
  return new NarsilError(ErrorCodes.INSTANCE_SHUT_DOWN, 'This Narsil instance has been shut down')
}

export function stoppedByShutdown(ctx: MutationContext, err: unknown): boolean {
  const { signal } = ctx.abortController
  if (!signal.aborted) return false
  if (err === signal.reason) return true
  if (err instanceof NarsilError) {
    return err.code === ErrorCodes.INSTANCE_SHUT_DOWN || err.code === ErrorCodes.INDEX_NOT_FOUND
  }
  return err instanceof Error && err.name === 'AbortError'
}

export function batchFailureOf(
  ctx: MutationContext,
  err: unknown,
  failureOf: (err: unknown) => NarsilError,
): NarsilError {
  if (!stoppedByShutdown(ctx, err)) return failureOf(err)
  return err instanceof NarsilError && err.code === ErrorCodes.INSTANCE_SHUT_DOWN ? err : shutDownError()
}

export function providedDocIdOrEmpty(document: AnyDocument): string {
  return providedDocId(document) ?? ''
}

export function failAsShutDown<T>(
  failed: BatchResult['failed'],
  entries: readonly T[],
  docIdOf: (entry: T) => string,
  start = 0,
  end = entries.length,
): void {
  if (start >= end) return
  const error = shutDownError()
  for (let i = start; i < end; i++) failed.push({ docId: docIdOf(entries[i]), error })
}

export function applyUnlessShutDown(ctx: MutationContext, apply: ApplyMutation): ApplyMutation {
  return () => {
    if (batchStopped(ctx)) throw shutDownError()
    return apply()
  }
}

export async function unlessShutDown(ctx: MutationContext, work: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await work()
  } catch (err) {
    if (!batchStopped(ctx)) throw err
  }
}
