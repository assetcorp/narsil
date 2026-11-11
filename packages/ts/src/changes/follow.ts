import { decode, isSyncEpoch, restoreVectorFields } from '#platform/storage-host'
import type { EngineCore } from '../engine/core'
import { ENTRIES_MESSAGE_LIMIT_BYTES, FEED_HEAD_RETRY_MS } from '../sync/feed/constants'
import { createSemaphore } from '../sync/feed/limits'
import type { FeedChange } from '../sync/feed/source'
import type { Change, ChangesEvent, FollowChangesOptions } from '../types/changes'
import type { AnyDocument } from '../types/schema'
import { CHANGES_IDLE_RECHECK_MS, MAX_FOLLOWER_CATCH_UPS } from './constants'
import {
  ChangeCursor,
  type CursorBatch,
  changesNotEnabled,
  invalidPositions,
  previousDocumentRequired,
  type SubscriptionRequest,
} from './cursor'
import type { DerivedChange } from './derive'
import { engineChangeSource } from './engine-source'
import { changePositionList, changePositionsOf } from './protocol'
import type { ChangeSource } from './source'

type FollowCore = Pick<
  EngineCore,
  'durability' | 'indexRegistry' | 'executor' | 'eventHandlers' | 'guardShutdown' | 'requireIndex'
>

function requestOf(indexName: string, options: FollowChangesOptions): SubscriptionRequest {
  const { epoch, positions, filter } = options
  if ((epoch === undefined) !== (positions === undefined)) {
    throw invalidPositions(indexName, 'Pass epoch and positions together, or leave both out')
  }
  const request: SubscriptionRequest = filter === undefined ? {} : { filter }
  if (epoch === undefined) return request
  if (!isSyncEpoch(epoch)) throw invalidPositions(indexName, 'The epoch must be 32 lowercase hexadecimal digits')
  const valid = changePositionsOf(positions)
  if (valid === null) {
    throw invalidPositions(indexName, 'Each position needs a whole partitionId and a whole, non-negative seqNo')
  }
  return { ...request, epoch, positions: valid }
}

function documentOf(bytes: Uint8Array, vectorFieldPaths: ReadonlySet<string>): AnyDocument {
  const document = decode(bytes) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)
  return document as AnyDocument
}

function eventOf(batch: CursorBatch, vectorFieldPaths: ReadonlySet<string>): ChangesEvent {
  const changes = batch.changes.map((change: DerivedChange): Change => {
    const shaped: Change = { seqNo: change.seqNo, type: change.type, documentId: change.documentId }
    if (change.document !== null) shaped.document = documentOf(change.document, vectorFieldPaths)
    if (change.previousDocument !== null) {
      shaped.previousDocument = documentOf(change.previousDocument, vectorFieldPaths)
    }
    return shaped
  })
  return { type: 'changes', partitionId: batch.partitionId, changes, scannedSeqNo: batch.scannedSeqNo }
}

interface Wakeup {
  wait(ms: number): Promise<void>
  stop(): void
}

function wakeupOn(source: ChangeSource, indexName: string, signal: AbortSignal | undefined): Wakeup {
  let pending = false
  let wake: (() => void) | null = null
  const fire = (): void => {
    pending = true
    wake?.()
  }
  const stopListening = source.listen((change: FeedChange) => {
    if (change.indexName === indexName) fire()
  })
  const stopWatching = source.watchIndex?.(indexName)
  signal?.addEventListener('abort', fire)
  return {
    async wait(ms) {
      if (pending) {
        pending = false
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await new Promise<void>(resolve => {
        wake = resolve
        timer = setTimeout(resolve, ms)
      })
      clearTimeout(timer)
      wake = null
      pending = false
    },
    stop() {
      stopListening()
      stopWatching?.()
      signal?.removeEventListener('abort', fire)
    },
  }
}

export interface FollowSourceDeps {
  source: ChangeSource
  guard(): void
  vectorFieldPaths(indexName: string): Promise<ReadonlySet<string>>
}

export function followIndexChanges(
  core: FollowCore,
  indexName: string,
  options: FollowChangesOptions = {},
): AsyncGenerator<ChangesEvent, void, undefined> {
  core.guardShutdown()
  core.requireIndex(indexName)
  return followSourceChanges(
    {
      source: engineChangeSource(core),
      guard: () => core.guardShutdown(),
      vectorFieldPaths: async name => core.requireIndex(name).vectorFieldPaths,
    },
    indexName,
    options,
  )
}

export async function* followSourceChanges(
  deps: FollowSourceDeps,
  indexName: string,
  options: FollowChangesOptions = {},
): AsyncGenerator<ChangesEvent, void, undefined> {
  deps.guard()
  const request = requestOf(indexName, options)
  const { source } = deps
  const { signal } = options
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return
  const wakeup = wakeupOn(source, indexName, signal)
  try {
    const opened = await ChangeCursor.open(
      { source, indexName, reads: createSemaphore(MAX_FOLLOWER_CATCH_UPS) },
      request,
    )
    if (typeof opened === 'string') {
      yield { type: 'resync', reason: opened }
      return
    }
    const cursor = opened
    const { state } = cursor
    const vectorFieldPaths = await deps.vectorFieldPaths(indexName)
    yield {
      type: 'subscribed',
      epoch: state.epoch,
      partitionCount: state.partitionCount,
      positions: changePositionList(cursor.subscribedSeqNos),
      heads: changePositionList(cursor.heads),
      bytesBehind: cursor.bytesBehind,
      previousDocument: state.previousDocument,
    }
    while (!aborted()) {
      deps.guard()
      const current = source.changesState(indexName)
      if (current === null) throw changesNotEnabled(indexName)
      if (current.epoch !== state.epoch) {
        yield { type: 'resync', reason: 'epoch' }
        return
      }
      if (cursor.filtered && !current.previousDocument) throw previousDocumentRequired(indexName)
      await cursor.refreshHeads()
      let progressed = false
      for (let partitionId = 0; partitionId < state.partitionCount; partitionId++) {
        if (aborted() || !cursor.behind(partitionId)) continue
        const batch = await cursor.readBatch(partitionId, ENTRIES_MESSAGE_LIMIT_BYTES)
        if (batch === 'history') {
          yield { type: 'resync', reason: 'history' }
          return
        }
        if (batch === null) continue
        if (source.changesState(indexName)?.epoch !== state.epoch) break
        cursor.commit(batch)
        progressed = true
        yield eventOf(batch, vectorFieldPaths)
      }
      if (!progressed) await wakeup.wait(cursor.awaitsDurability() ? FEED_HEAD_RETRY_MS : CHANGES_IDLE_RECHECK_MS)
    }
  } finally {
    wakeup.stop()
  }
}
