import { ErrorCodes, NarsilError } from '../../../errors'
import { crc32 } from '../../../serialization/crc32'
import { MAX_SNAPSHOT_SIZE_BYTES } from '../../replication/constants'
import type { SnapshotSyncRequestPayload, TransportMessage } from '../../transport/types'
import {
  acquireSnapshotBuild,
  acquireSourceSlot,
  acquireStreamSlot,
  releaseSourceSlot,
  releaseStreamSlot,
  type SnapshotBuildResult,
  type SourceSlotHandle,
  type StreamSlotHandle,
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
    await respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return
  }

  try {
    let build: SnapshotBuildResult
    try {
      const buildForRequest = async () => buildSnapshotForRequest(deps, indexName, options)
      build =
        options.disableBuildCache === true
          ? await buildForRequest()
          : await acquireSnapshotBuild(deps.state, indexName, buildForRequest)
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED
      const errMessage = err instanceof Error ? err.message : String(err)
      await respondError(sink, deps.nodeId, message.requestId, code, errMessage)
      return
    }

    if (build.bytes.byteLength > MAX_SNAPSHOT_SIZE_BYTES) {
      await respondError(
        sink,
        deps.nodeId,
        message.requestId,
        ErrorCodes.SNAPSHOT_SYNC_TOO_LARGE,
        `Snapshot size ${build.bytes.byteLength} exceeds the ${MAX_SNAPSHOT_SIZE_BYTES} byte limit`,
      )
      return
    }

    let streamHandle: StreamSlotHandle
    try {
      streamHandle = acquireStreamSlot(deps.state, indexName)
    } catch (err) {
      const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED
      const errMessage = err instanceof Error ? err.message : String(err)
      await respondError(sink, deps.nodeId, message.requestId, code, errMessage)
      return
    }

    try {
      const metadata = options.metadata ?? (await resolveHeaderMetadata(deps, indexName, request.partitionId ?? null))
      await streamSnapshotToReplica(sink, deps.nodeId, message.requestId, indexName, build, metadata, {
        closeOnEnd: options.closeOnEnd,
      })
      await options.afterSnapshot?.(sink)
      if (options.closeOnEnd === false) {
        sink.closed = true
      }
    } finally {
      releaseStreamSlot(deps.state, streamHandle)
    }
  } finally {
    releaseSourceSlot(deps.state, sourceHandle)
  }
}

export async function buildSnapshot(deps: SnapshotSyncHandlerDeps, indexName: string): Promise<SnapshotBuildResult> {
  let bytes: Uint8Array
  try {
    bytes = await deps.engine.snapshot(indexName)
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
  const checksum = bytes.byteLength <= MAX_SNAPSHOT_SIZE_BYTES ? crc32(bytes) : 0
  return { bytes, checksum }
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
