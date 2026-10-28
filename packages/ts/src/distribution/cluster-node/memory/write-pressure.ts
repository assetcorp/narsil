import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { ForwardBatchOperation } from '../../transport/types'
import { DOCUMENT_ENTRY_OVERHEAD_BYTES, DOCUMENT_NUMBER_BYTES, DOCUMENT_SCALAR_BYTES } from '../constants'

const WRITE_BYTES_IN_FLIGHT_REASON = 'write_bytes_in_flight'

export interface WritePressure {
  admit(indexName: string, bytes: number): () => void
}

export interface WritePressureOptions {
  nodeId: string
  limitBytes: number
  beforeAdmit: () => void
}

export function createWritePressure(options: WritePressureOptions): WritePressure {
  let inFlight = 0

  return {
    admit(indexName, bytes) {
      options.beforeAdmit()
      const requestBytes = Math.max(0, Math.ceil(bytes))
      if (inFlight > 0 && inFlight + requestBytes > options.limitBytes) {
        throw new NarsilError(
          ErrorCodes.CLUSTER_WRITE_BLOCKED,
          `Node '${options.nodeId}' refuses this write to index '${indexName}' because its ${requestBytes} bytes would take the writes in flight on the node from ${inFlight} bytes past the limit of ${options.limitBytes} bytes. Retry once the writes in flight finish, or send smaller batches.`,
          {
            reason: WRITE_BYTES_IN_FLIGHT_REASON,
            indexName,
            nodeId: options.nodeId,
            requestBytes,
            inFlightBytes: inFlight,
            limitBytes: options.limitBytes,
          },
        )
      }
      inFlight += requestBytes
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        inFlight -= requestBytes
      }
    },
  }
}

export async function withAdmittedWrite<T>(
  pressure: WritePressure | undefined,
  indexName: string,
  bytes: () => number,
  work: () => Promise<T>,
): Promise<T> {
  if (pressure === undefined) {
    return work()
  }
  const release = pressure.admit(indexName, bytes())
  try {
    return await work()
  } finally {
    release()
  }
}

export function estimateDocumentBytes(document: Record<string, unknown>): number {
  let bytes = 0
  const pending: unknown[] = [document]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') {
      bytes += value.length
      continue
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      bytes += DOCUMENT_NUMBER_BYTES
      continue
    }
    if (value === null || typeof value !== 'object') {
      bytes += DOCUMENT_SCALAR_BYTES
      continue
    }
    if (visited.has(value)) {
      continue
    }
    visited.add(value)
    if (ArrayBuffer.isView(value)) {
      bytes += value.byteLength
    } else if (Array.isArray(value)) {
      bytes += DOCUMENT_ENTRY_OVERHEAD_BYTES
      for (const item of value) {
        pending.push(item)
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        bytes += key.length + DOCUMENT_ENTRY_OVERHEAD_BYTES
        pending.push(item)
      }
    }
  }
  return bytes
}

export function estimateDocumentsBytes(documents: Iterable<AnyDocument>): number {
  let bytes = 0
  for (const document of documents) {
    bytes += estimateDocumentBytes(document)
  }
  return bytes
}

export function estimateForwardedBytes(operation: Pick<ForwardBatchOperation, 'document' | 'updateFields'>): number {
  const documentBytes = operation.document?.byteLength ?? 0
  return operation.updateFields === null ? documentBytes : documentBytes + estimateDocumentBytes(operation.updateFields)
}
