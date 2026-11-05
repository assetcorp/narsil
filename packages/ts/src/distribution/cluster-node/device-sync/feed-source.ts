import { decode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { BoundsFreshness, FeedChange, FeedSource, PartitionBounds } from '../../../sync/feed/source'
import type { ClusterCoordinator } from '../../coordinator/types'
import { isRecord } from '../../payload-guards'
import { TransportError } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'
import { resolveNodeTargets } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'
import { DEVICE_SYNC_BOUNDS_REUSE_MS, DEVICE_SYNC_HEAD_POLL_MS } from './constants'
import { answerSyncRead, type SyncReadDeps } from './read-handler'
import { createSyncReadMessage, decodeSyncReadReply, type SyncReadReply } from './read-message'
import type { DeviceSyncView } from './view'

export interface ClusterFeedSourceDeps extends SyncReadDeps {
  config: ClusterNodeConfig
  coordinator: ClusterCoordinator
  engine: SyncReadDeps['engine'] & Pick<ClusterLocalEngine, 'on' | 'off'>
  view: DeviceSyncView
  refreshAllocation(indexName: string): Promise<unknown>
  snapshotBytes(indexName: string): Promise<number>
}

const NO_ENTRIES_AFTER = Number.MAX_SAFE_INTEGER
const PRIMARY_MOVED_CODES: ReadonlySet<string> = new Set([ErrorCodes.PARTITION_NOT_PRIMARY])

interface ReusedBounds {
  at: number
  reply: Promise<SyncReadReply>
  settled: boolean
}

function settledEither(): void {}

function replyError(nodeId: string, decoded: unknown, indexName: string, partitionId: number): NarsilError {
  const reply = isRecord(decoded) ? decoded : {}
  return new NarsilError(
    typeof reply.code === 'string' ? reply.code : ErrorCodes.QUERY_ROUTING_FAILED,
    typeof reply.message === 'string'
      ? reply.message
      : `Node '${nodeId}' did not answer sync.read for partition ${partitionId} of index '${indexName}'`,
    { indexName, partitionId, targetNodeId: nodeId },
  )
}

export function createClusterFeedSource(deps: ClusterFeedSourceDeps): FeedSource {
  const { view, coordinator, config } = deps
  const reusedBounds = new Map<string, ReusedBounds>()
  const queuedBounds = new Map<string, Promise<SyncReadReply>>()
  const watched = new Map<string, number>()
  const lastHeads = new Map<string, number>()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let polling = false
  const listeners = new Set<(change: FeedChange) => void>()

  function emit(change: FeedChange): void {
    for (const listener of listeners) listener(change)
  }

  function serving(indexName: string) {
    const held = view.held(indexName)
    if (held === undefined) {
      throw new NarsilError(ErrorCodes.SYNC_NOT_ENABLED, `Index "${indexName}" has device sync off`, { indexName })
    }
    return held.serving
  }

  async function askPrimary(primary: string, indexName: string, request: Parameters<typeof answerSyncRead>[1]) {
    if (primary === deps.nodeId) return answerSyncRead(deps, request)
    const message = createSyncReadMessage(request, deps.nodeId, generateId())
    let lastError: unknown
    for (const target of await resolveNodeTargets(config, primary)) {
      let response: Awaited<ReturnType<typeof config.transport.send>>
      try {
        response = await config.transport.send(target, message)
      } catch (error) {
        lastError = error
        continue
      }
      const decoded: unknown = decode(response.payload)
      if (response.type.endsWith('.error')) throw replyError(primary, decoded, indexName, request.partitionId)
      const reply = decodeSyncReadReply(decoded, request.partitionId, request.afterSeqNo)
      if (reply === null) throw replyError(primary, null, indexName, request.partitionId)
      return reply
    }
    throw new NarsilError(
      ErrorCodes.QUERY_NODE_TIMEOUT,
      `Node '${primary}' did not answer sync.read for partition ${request.partitionId} of index '${indexName}'`,
      {
        indexName,
        partitionId: request.partitionId,
        ...(lastError instanceof TransportError ? { transportCode: lastError.code } : {}),
      },
    )
  }

  async function readFromPrimary(
    indexName: string,
    partitionId: number,
    afterSeqNo: number,
    maxBytes: number,
  ): Promise<SyncReadReply> {
    const layout = serving(indexName)
    const request = { indexName: layout.servingName, indexUuid: layout.indexUuid, partitionId, afterSeqNo, maxBytes }
    for (let attempt = 0; ; attempt++) {
      const table = await coordinator.getAllocation(layout.servingName)
      const primary = table?.assignments.get(partitionId)?.primary ?? null
      if (primary === null) {
        throw new NarsilError(
          ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
          `Partition ${partitionId} of index '${indexName}' has no primary to read the feed from`,
          { indexName, partitionId },
        )
      }
      try {
        return await askPrimary(primary, indexName, request)
      } catch (error) {
        if (attempt > 0 || !(error instanceof NarsilError) || !PRIMARY_MOVED_CODES.has(error.code)) throw error
        await deps.refreshAllocation(layout.servingName)
      }
    }
  }

  function startBoundsRead(indexName: string, partitionId: number, key: string): Promise<SyncReadReply> {
    const reply = readFromPrimary(indexName, partitionId, NO_ENTRIES_AFTER, 1)
    const started: ReusedBounds = { at: performance.now(), reply, settled: false }
    reusedBounds.set(key, started)
    reply.then(
      () => {
        started.settled = true
      },
      () => {
        started.settled = true
        if (reusedBounds.get(key) === started) reusedBounds.delete(key)
      },
    )
    return reply
  }

  function bounds(
    indexName: string,
    partitionId: number,
    freshness: BoundsFreshness = 'recent',
  ): Promise<SyncReadReply> {
    const key = `${indexName}\u0000${partitionId}`
    const latest = reusedBounds.get(key)
    if (freshness === 'recent') {
      if (latest !== undefined && performance.now() - latest.at < DEVICE_SYNC_BOUNDS_REUSE_MS) return latest.reply
      return startBoundsRead(indexName, partitionId, key)
    }
    if (latest === undefined || latest.settled) return startBoundsRead(indexName, partitionId, key)
    const queued = queuedBounds.get(key)
    if (queued !== undefined) return queued
    const next = latest.reply.then(settledEither, settledEither).then(() => {
      queuedBounds.delete(key)
      return startBoundsRead(indexName, partitionId, key)
    })
    queuedBounds.set(key, next)
    return next
  }

  async function pollHeads(): Promise<void> {
    if (polling) return
    polling = true
    try {
      for (const indexName of watched.keys()) {
        const held = view.held(indexName)
        if (held === undefined) continue
        let rose = false
        for (let partitionId = 0; partitionId < held.serving.partitionCount; partitionId++) {
          const key = `${indexName}\u0000${partitionId}`
          const head = (await bounds(indexName, partitionId).catch(() => null))?.head
          if (head === undefined) continue
          if (head > (lastHeads.get(key) ?? -1)) rose = true
          lastHeads.set(key, head)
        }
        if (rose) emit({ kind: 'advanced', indexName })
      }
    } finally {
      polling = false
    }
  }

  function namesServedBy(localName: string): string[] {
    const names: string[] = []
    for (const indexName of watched.keys()) {
      if (view.held(indexName)?.serving.servingName === localName) names.push(indexName)
    }
    return names
  }

  const onLocalWrite = (payload: { indexName: string }): void => {
    for (const indexName of namesServedBy(payload.indexName)) {
      reusedBounds.forEach((_, key) => {
        if (key.startsWith(`${indexName}\u0000`)) reusedBounds.delete(key)
      })
      emit({ kind: 'advanced', indexName })
    }
  }

  return {
    indexState(indexName) {
      const held = view.held(indexName)
      const sync = held?.settings
      if (held === undefined || sync?.sync?.enabled !== true || sync.syncEpoch === undefined) return null
      return { epoch: sync.syncEpoch, partitionCount: held.serving.partitionCount, settings: held.feedSettings }
    },

    async bounds(indexName, partitionId, freshness): Promise<PartitionBounds> {
      const reply = await bounds(indexName, partitionId, freshness)
      return { oldestSeqNo: reply.oldestSeqNo, head: reply.head, highestSeqNo: reply.highestSeqNo }
    },

    async read(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes) {
      const reply = await readFromPrimary(indexName, partitionId, afterSeqNo, maxBytes)
      const gone = afterSeqNo + 1 < reply.oldestSeqNo && afterSeqNo < reply.head
      return { frames: gone ? [] : reply.frames.filter(frame => frame.seqNo <= upToSeqNo), gone }
    },

    async bytesBehind(indexName, seqNos) {
      let bytes = 0
      for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
        bytes += (await readFromPrimary(indexName, partitionId, seqNos[partitionId], 1)).bytesBehind
      }
      return bytes
    },

    snapshotBytes: indexName => deps.snapshotBytes(indexName),

    pendingBeyondHead: () => false,

    listen(onChange) {
      listeners.add(onChange)
      const stopView = view.listen(onChange)
      if (listeners.size === 1) deps.engine.on('write', onLocalWrite)
      return () => {
        stopView()
        listeners.delete(onChange)
        if (listeners.size === 0) deps.engine.off('write', onLocalWrite)
      }
    },

    watchIndex(indexName) {
      watched.set(indexName, (watched.get(indexName) ?? 0) + 1)
      if (pollTimer === null) {
        pollTimer = setInterval(() => void pollHeads(), DEVICE_SYNC_HEAD_POLL_MS)
        pollTimer.unref?.()
      }
      let watching = true
      return () => {
        if (!watching) return
        watching = false
        const count = (watched.get(indexName) ?? 1) - 1
        if (count > 0) {
          watched.set(indexName, count)
          return
        }
        watched.delete(indexName)
        for (const key of [...lastHeads.keys()]) if (key.startsWith(`${indexName}\u0000`)) lastHeads.delete(key)
        if (watched.size === 0 && pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
    },
  }
}
