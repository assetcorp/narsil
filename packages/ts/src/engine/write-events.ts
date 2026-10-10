import type { EngineCore } from './core'
import { emitEngineEvent } from './events'
import { awaitWriteVisibility } from './mutations/write-visibility'

const WRITE_EVENT = 'write'

export type WriteEventSource = Pick<EngineCore, 'eventHandlers' | 'mutationCtx'>

export function emitWriteEvent(source: WriteEventSource, indexName: string): void {
  const handlers = source.eventHandlers.get(WRITE_EVENT)
  if (handlers === undefined || handlers.size === 0) return
  const emit = (): void => {
    emitEngineEvent(source.eventHandlers, WRITE_EVENT, { indexName })
  }
  awaitWriteVisibility(source.mutationCtx, indexName).then(emit, emit)
}

export async function emitWriteEventAfter<T>(
  source: WriteEventSource,
  indexName: string,
  write: Promise<T>,
): Promise<T> {
  try {
    return await write
  } finally {
    emitWriteEvent(source, indexName)
  }
}
