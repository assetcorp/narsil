import type { IndexMetadata } from '../../types/internal'
import { CHECKPOINT_WORKER_HEARTBEAT_MS } from './constants'
import { rebuildSnapshotFromDurable } from './rebuild'
import type { SegmentedCheckpointOutcome, VectorsWrittenFromMemory } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface CheckpointWorkerRequest {
  root: string
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  vectorsAlreadyWritten?: VectorsWrittenFromMemory
}

function validVectorsAlreadyWritten(value: unknown): value is VectorsWrittenFromMemory | undefined {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).every(refs => Array.isArray(refs))
}

export interface CheckpointWorkerSuccess {
  type: 'success'
  outcome: SegmentedCheckpointOutcome
}

export interface CheckpointWorkerError {
  type: 'error'
  message: string
}

export interface CheckpointWorkerHeartbeat {
  type: 'heartbeat'
}

export type CheckpointWorkerMessage = CheckpointWorkerSuccess | CheckpointWorkerError | CheckpointWorkerHeartbeat

async function handleRequest(raw: unknown): Promise<CheckpointWorkerSuccess> {
  const request = raw as CheckpointWorkerRequest
  if (typeof request.root !== 'string' || request.root.length === 0) {
    throw new Error('Checkpoint request is missing a durable root path')
  }
  if (request.metadata === null || typeof request.metadata !== 'object') {
    throw new Error('Checkpoint request is missing index metadata')
  }
  if (!Array.isArray(request.targets)) {
    throw new Error('Checkpoint request is missing partition targets')
  }
  if (!Number.isInteger(request.compactionThreshold) || request.compactionThreshold <= 0) {
    throw new Error('Checkpoint request has an invalid compaction threshold')
  }
  if (!validVectorsAlreadyWritten(request.vectorsAlreadyWritten)) {
    throw new Error('Checkpoint request names vector segments in a shape the worker cannot read')
  }
  const outcome = await rebuildSnapshotFromDurable(
    request.root,
    request.metadata,
    request.targets,
    request.compactionThreshold,
    request.vectorsAlreadyWritten,
  )
  return { type: 'success', outcome }
}

async function setupAsync(): Promise<void> {
  let parentPort: import('node:worker_threads').MessagePort | null = null
  try {
    const workerThreads = await import('node:worker_threads')
    parentPort = workerThreads.parentPort ?? null
  } catch {
    parentPort = null
  }

  if (parentPort === null) {
    return
  }

  const port = parentPort
  port.on('message', (raw: unknown) => {
    const heartbeat = setInterval(
      () => port.postMessage({ type: 'heartbeat' } satisfies CheckpointWorkerHeartbeat),
      CHECKPOINT_WORKER_HEARTBEAT_MS,
    )
    handleRequest(raw)
      .then(result => port.postMessage(result))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        port.postMessage({ type: 'error', message } satisfies CheckpointWorkerError)
      })
      .finally(() => clearInterval(heartbeat))
  })
}

function setupWorker(): void {
  setupAsync().catch(err => {
    console.error('Checkpoint worker setup failed:', err)
  })
}

export { handleRequest }

setupWorker()
