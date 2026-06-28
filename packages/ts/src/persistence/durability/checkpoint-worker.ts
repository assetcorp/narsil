import type { IndexMetadata } from '../../types/internal'
import { rebuildSnapshotFromDurable } from './rebuild'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface CheckpointWorkerRequest {
  root: string
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
}

export interface CheckpointWorkerSuccess {
  type: 'success'
}

export interface CheckpointWorkerError {
  type: 'error'
  message: string
}

export type CheckpointWorkerMessage = CheckpointWorkerSuccess | CheckpointWorkerError

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
  await rebuildSnapshotFromDurable(request.root, request.metadata, request.targets, request.compactionThreshold)
  return { type: 'success' }
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
    handleRequest(raw)
      .then(result => port.postMessage(result))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        port.postMessage({ type: 'error', message } satisfies CheckpointWorkerError)
      })
  })
}

function setupWorker(): void {
  setupAsync().catch(err => {
    console.error('Checkpoint worker setup failed:', err)
  })
}

export { handleRequest }

setupWorker()
