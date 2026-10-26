import { ErrorCodes, NarsilError } from '../../../errors'
import { defaultSpoolDirectory, spoolSnapshotStream } from '../../replication/snapshot-spool'
import type { SnapshotSyncRequestPayload, TransportMessage } from '../../transport/types'
import { transportableDetails } from '../error-reply'
import {
  acquireSnapshotBuild,
  acquireSourceSlot,
  acquireStreamSlot,
  releaseSourceSlot,
  releaseStreamSlot,
  type SnapshotBuildLease,
  type SnapshotBuildResult,
  type SourceSlotHandle,
  type StreamSlotHandle,
  soleSnapshotLease,
} from '../snapshot-cache'
import { respondError, type SingleResponseSink, streamSnapshotToReplica } from '../snapshot-stream-writer'

import { resolveHeaderMetadata } from './metadata'
import type { SnapshotSyncHandlerDeps, SnapshotSyncStreamOptions } from './types'

export async function acquireAndStream(
  message: TransportMessage,
  sink: SingleResponseSink,
  request: SnapshotSyncRequestPayload,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions,
): Promise<void> {
  const { indexName } = request
  let sourceHandle: SourceSlotHandle
  try {
    sourceHandle = acquireSourceSlot(deps.state, message.sourceId, indexName)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    await respondError(sink, deps.nodeId, message.requestId, code, errMessage, transportableDetails(err))
    return
  }

  try {
    let lease: SnapshotBuildLease
    try {
      const buildForRequest = async () => buildSnapshotForRequest(deps, indexName, options)
      lease =
        options.disableBuildCache === true
          ? soleSnapshotLease(await buildForRequest())
          : await acquireSnapshotBuild(deps.state, indexName, buildForRequest)
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED
      const errMessage = err instanceof Error ? err.message : String(err)
      await respondError(sink, deps.nodeId, message.requestId, code, errMessage, transportableDetails(err))
      return
    }

    try {
      await streamLeasedSnapshot(message, sink, request, deps, options, lease.build)
    } finally {
      await lease.release()
    }
  } finally {
    releaseSourceSlot(deps.state, sourceHandle)
  }
}

async function streamLeasedSnapshot(
  message: TransportMessage,
  sink: SingleResponseSink,
  request: SnapshotSyncRequestPayload,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions,
  build: SnapshotBuildResult,
): Promise<void> {
  const { indexName } = request
  let streamHandle: StreamSlotHandle
  try {
    streamHandle = acquireStreamSlot(deps.state, indexName)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    await respondError(sink, deps.nodeId, message.requestId, code, errMessage, transportableDetails(err))
    return
  }

  try {
    const resolved = options.metadata ?? (await resolveHeaderMetadata(deps, indexName, request.partitionId ?? null))
    const metadata = build.lastSeqNo === undefined ? resolved : { ...resolved, lastSeqNo: build.lastSeqNo }
    await streamSnapshotToReplica(sink, deps.nodeId, message.requestId, indexName, build, metadata, {
      closeOnEnd: options.closeOnEnd,
    })
    await options.afterSnapshot?.(sink, build)
    if (options.closeOnEnd === false) {
      sink.closed = true
    }
  } finally {
    releaseStreamSlot(deps.state, streamHandle)
  }
}

export async function buildSnapshot(deps: SnapshotSyncHandlerDeps, indexName: string): Promise<SnapshotBuildResult> {
  try {
    return await spoolSnapshotStream(
      deps.spoolDirectory ?? defaultSpoolDirectory(),
      await deps.engine.snapshot(indexName),
    )
  } catch (err) {
    if (err instanceof NarsilError) {
      throw err
    }
    const errMessage = err instanceof Error ? err.message : String(err)
    throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED, `engine.snapshot failed: ${errMessage}`, {
      indexName,
      cause: errMessage,
    })
  }
}

export function buildSnapshotForRequest(
  deps: SnapshotSyncHandlerDeps,
  indexName: string,
  options: SnapshotSyncStreamOptions,
): Promise<SnapshotBuildResult> | SnapshotBuildResult {
  if (options.buildSnapshot !== undefined) {
    return options.buildSnapshot(indexName)
  }
  return buildSnapshot(deps, indexName)
}
