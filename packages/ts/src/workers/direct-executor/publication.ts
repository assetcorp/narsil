import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { CopyPublication } from '../copy-publication'
import type { WorkerAction } from '../protocol'
import { prepareVectorPublication } from '../vector-copies'
import type { IndexEntry } from './types'

interface PendingPublication {
  apply(): Promise<void>
  reject(error: unknown): void
}

export interface CopyPublicationOrder {
  generation: number
  pending: Map<number, PendingPublication>
  applying: boolean
  failed: boolean
}

export function createCopyPublicationOrder(): CopyPublicationOrder {
  return { generation: 0, pending: new Map(), applying: false, failed: false }
}

export function initializeCopyPublication(entry: IndexEntry, publication: CopyPublication, threadSlot: number): void {
  prepareVectorPublication(entry.vectorCopies, entry.manager, publication, threadSlot).commit()
  entry.copyPublications.generation = publication.generation
}

export function closeCopyPublicationOrder(order: CopyPublicationOrder): void {
  order.failed = true
  const error = new NarsilError(ErrorCodes.WORKER_CRASHED, 'The index copy no longer accepts publications')
  for (const pending of order.pending.values()) pending.reject(error)
  order.pending.clear()
}

function drainPublications(order: CopyPublicationOrder): void {
  if (order.applying || order.failed) return
  const next = order.pending.get(order.generation + 1)
  if (next === undefined) return
  order.pending.delete(order.generation + 1)
  order.applying = true
  void next.apply().finally(() => {
    order.applying = false
    drainPublications(order)
  })
}

export function publishCopyAction<T>(
  action: WorkerAction,
  entry: IndexEntry,
  threadSlot: number,
  isCurrent: () => boolean,
  work: () => Promise<T>,
): Promise<T> {
  const publication = action.publication
  if (publication === undefined) {
    return publishWorkerAction(action, entry.manager, () => {
      if (!isCurrent()) throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'The index copy was replaced')
      return work()
    })
  }
  const order = entry.copyPublications
  if (order.failed)
    return Promise.reject(new NarsilError(ErrorCodes.WORKER_CRASHED, 'The index copy requires reloading'))
  if (publication.generation <= order.generation) return Promise.resolve(undefined as T)
  if (
    order.pending.has(publication.generation) ||
    (order.applying && publication.generation === order.generation + 1)
  ) {
    return Promise.reject(new NarsilError(ErrorCodes.WORKER_CRASHED, 'The index copy received a duplicate publication'))
  }
  return new Promise<T>((resolve, reject) => {
    order.pending.set(publication.generation, {
      reject,
      async apply() {
        try {
          const value = await entry.manager.publication.write(async () => {
            try {
              if (!isCurrent()) throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'The index copy was replaced')
              const vectors = prepareVectorPublication(entry.vectorCopies, entry.manager, publication, threadSlot)
              try {
                const value = await work()
                vectors.commit()
                order.generation = publication.generation
                return value
              } finally {
                vectors.release()
              }
            } catch (error) {
              closeCopyPublicationOrder(order)
              throw error
            }
          })
          resolve(value)
        } catch (error) {
          closeCopyPublicationOrder(order)
          reject(error)
        }
      },
    })
    drainPublications(order)
  })
}

const READ_ACTIONS: ReadonlySet<WorkerAction['type']> = new Set([
  'get',
  'has',
  'count',
  'getStats',
  'serialize',
  'memoryReport',
  'buildSegment',
  'compactSegments',
])

export function publishWorkerAction<T>(
  action: WorkerAction,
  manager: PartitionManager | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (manager === undefined || action.type === 'query' || action.type === 'preflight') return work()
  return READ_ACTIONS.has(action.type) ? manager.publication.read(work) : manager.publication.write(work)
}
