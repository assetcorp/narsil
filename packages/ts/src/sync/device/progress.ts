import { KEPT_ENTRY_FLUSH_BYTES, KEPT_ENTRY_FLUSH_IDLE_MS, KEPT_ENTRY_OVERHEAD_BYTES } from './constants'
import type { DeviceContext } from './context'
import { applyEntryLocally, applyWriteLocally, holdsIndex, newestByDocument } from './local-writes'
import type { DevicePosition, KeptEntry } from './types'

export interface Progress {
  position(): DevicePosition | null
  received(): readonly number[]
  recover(): Promise<void>
  keep(partitionId: number, entries: readonly KeptEntry[]): Promise<void>
  settleUploaded(sequences: readonly number[]): Promise<void>
  forgetDeferred(documentId: string): void
  adopt(position: DevicePosition): Promise<void>
  reapplyQueue(): Promise<void>
  save(): Promise<void>
  reached(heads: readonly number[]): boolean
  setFlushThreshold(windowBytes: number): void
  setAcknowledge(acknowledge: ((seqNos: readonly number[]) => void) | null): void
  cancelFlush(): void
  unsavedBytes(): number
}

function entryBytes(entry: KeptEntry): number {
  return entry.documentId.length * 2 + (entry.document?.byteLength ?? 0) + KEPT_ENTRY_OVERHEAD_BYTES
}

export function createProgress(context: DeviceContext): Progress {
  const { engine, indexName, store, queue, work } = context
  let position: DevicePosition | null = null
  let received: number[] = []
  let unsaved = 0
  let flushThreshold = KEPT_ENTRY_FLUSH_BYTES
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let acknowledge: ((seqNos: readonly number[]) => void) | null = null
  const deferred = new Map<string, KeptEntry>()

  function cancelFlush(): void {
    if (flushTimer !== null) clearTimeout(flushTimer)
    flushTimer = null
  }

  async function saveWithinWork(): Promise<void> {
    cancelFlush()
    if (position === null) return
    if (unsaved === 0 && received.every((seqNo, partitionId) => seqNo === position?.seqNos[partitionId])) return
    await context.makeDurable()
    const next = { epoch: position.epoch, seqNos: [...received] }
    await store.writePosition(next)
    position = next
    await store.clearKeptEntries()
    unsaved = 0
    acknowledge?.(next.seqNos)
  }

  function scheduleFlush(): void {
    if (context.stopped() || unsaved === 0) return
    if (unsaved >= flushThreshold) {
      cancelFlush()
      work.run(saveWithinWork).catch(context.report)
      return
    }
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      work.run(saveWithinWork).catch(context.report)
    }, KEPT_ENTRY_FLUSH_IDLE_MS)
  }

  async function reapplyQueue(): Promise<void> {
    if (!holdsIndex(engine, indexName)) return
    for (const write of queue.ordered()) {
      try {
        await applyWriteLocally(engine, indexName, write)
      } catch (error) {
        await store.removeWrites([write.sequence])
        queue.remove([write.sequence])
        context.report(error)
      }
    }
  }

  return {
    position: () => position,
    received: () => received,

    recover: () =>
      work.run(async () => {
        position = await store.readPosition()
        if (position !== null && !holdsIndex(engine, indexName)) {
          position = null
          await store.writePosition(null)
        }
        queue.reset(await store.queuedWrites())
        const kept = await store.keptEntries()
        received = position === null ? [] : [...position.seqNos]
        const saved = position?.seqNos ?? []
        const fresh = kept.filter(entry => entry.seqNo > (saved[entry.partitionId] ?? Number.POSITIVE_INFINITY))
        for (const entry of newestByDocument(fresh).values()) {
          if (!queue.holdsDocument(entry.documentId)) await applyEntryLocally(engine, indexName, entry)
        }
        for (const entry of fresh) {
          received[entry.partitionId] = Math.max(received[entry.partitionId] ?? 0, entry.seqNo)
        }
        unsaved = fresh.length
        if (fresh.length > 0) await saveWithinWork()
        else if (kept.length > 0) await store.clearKeptEntries()
        await reapplyQueue()
      }),

    async keep(partitionId, entries) {
      await work.run(async () => {
        const last = received[partitionId]
        if (last === undefined) return
        const fresh = entries.filter(entry => entry.seqNo > last)
        const newest = fresh[fresh.length - 1]
        if (newest === undefined) return
        await store.keepEntries(fresh)
        for (const entry of fresh) {
          unsaved += entryBytes(entry)
          if (queue.holdsDocument(entry.documentId)) deferred.set(entry.documentId, entry)
          else await applyEntryLocally(engine, indexName, entry)
        }
        received[partitionId] = newest.seqNo
      })
      scheduleFlush()
    },

    async settleUploaded(sequences) {
      await work.run(async () => {
        await store.removeWrites(sequences)
        queue.remove(sequences)
        for (const [documentId, entry] of deferred) {
          if (queue.holdsDocument(documentId)) continue
          deferred.delete(documentId)
          await applyEntryLocally(engine, indexName, entry)
        }
      })
      scheduleFlush()
    },

    forgetDeferred(documentId) {
      deferred.delete(documentId)
    },

    async adopt(next) {
      cancelFlush()
      deferred.clear()
      await reapplyQueue()
      await context.makeDurable()
      await store.writePosition(next)
      position = { epoch: next.epoch, seqNos: [...next.seqNos] }
      received = [...next.seqNos]
      unsaved = 0
      await store.clearDownload()
    },

    reapplyQueue,

    save: () => work.run(saveWithinWork),

    reached(heads) {
      return (
        heads.length === received.length && heads.every((head, partitionId) => (received[partitionId] ?? -1) >= head)
      )
    },

    setFlushThreshold(windowBytes) {
      flushThreshold = Math.max(1, Math.min(KEPT_ENTRY_FLUSH_BYTES, Math.floor(windowBytes / 2)))
    },

    setAcknowledge(next) {
      acknowledge = next
    },

    cancelFlush,

    unsavedBytes: () => unsaved,
  }
}
