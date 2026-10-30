import { ErrorCodes, NarsilError } from '../../../errors'
import type { TransportMessage } from '../../transport/types'
import { transportableDetails } from '../error-reply'
import {
  acquireSourceSlot,
  acquireStreamSlot,
  releaseSourceSlot,
  releaseStreamSlot,
  type SnapshotBuildResult,
  type SourceSlotHandle,
  type StreamSlotHandle,
} from '../snapshot-cache'
import { respondError, type SingleResponseSink, streamSnapshotToReplica } from '../snapshot-stream-writer'

import type { SnapshotSyncHandlerDeps, SnapshotSyncStreamOptions } from './types'

export async function acquireAndStream(
  message: TransportMessage,
  sink: SingleResponseSink,
  indexName: string,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions,
): Promise<void> {
  let sourceHandle: SourceSlotHandle
  try {
    sourceHandle = acquireSourceSlot(deps.state, message.sourceId, indexName)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    await respondError(sink, deps.nodeId, message, code, errMessage, transportableDetails(err))
    return
  }

  try {
    let build: SnapshotBuildResult
    try {
      build = await options.buildSnapshot(indexName)
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED
      const errMessage = err instanceof Error ? err.message : String(err)
      await respondError(sink, deps.nodeId, message, code, errMessage, transportableDetails(err))
      return
    }

    try {
      await streamBuiltSnapshot(message, sink, indexName, deps, options, build)
    } finally {
      await build.discard()
    }
  } finally {
    releaseSourceSlot(deps.state, sourceHandle)
  }
}

async function streamBuiltSnapshot(
  message: TransportMessage,
  sink: SingleResponseSink,
  indexName: string,
  deps: SnapshotSyncHandlerDeps,
  options: SnapshotSyncStreamOptions,
  build: SnapshotBuildResult,
): Promise<void> {
  let streamHandle: StreamSlotHandle
  try {
    streamHandle = acquireStreamSlot(deps.state, indexName)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
    const errMessage = err instanceof Error ? err.message : String(err)
    await respondError(sink, deps.nodeId, message, code, errMessage, transportableDetails(err))
    return
  }

  try {
    const metadata = {
      ...options.metadata,
      lastSeqNo: build.lastSeqNo ?? options.metadata.lastSeqNo,
      primaryTerm: build.primaryTerm ?? options.metadata.primaryTerm,
    }
    await streamSnapshotToReplica(sink, deps.nodeId, message.requestId, indexName, build, metadata)
    await options.afterSnapshot(sink, build)
    sink.closed = true
  } finally {
    releaseStreamSlot(deps.state, streamHandle)
  }
}
