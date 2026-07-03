import type { DatasetId } from '@delali/narsil-example-shared/manifest'
import type { DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared/types'
import { getBackend } from './get-backend'

/**
 * Server-side dataset-load jobs. A load runs to completion here regardless of
 * what the browser does; pages observe progress by polling and can reattach
 * after a reload. The registry lives on globalThis because Vite can
 * re-instantiate this module (HMR, separate SSR loads) while jobs are running.
 */

interface LoadJobRecord {
  datasetId: DatasetId
  status: DatasetLoadProgress
  running: boolean
  controller: AbortController
}

const JOBS_KEY = Symbol.for('narsil-server-app-load-jobs')
const g = globalThis as unknown as Record<symbol, Map<DatasetId, LoadJobRecord> | undefined>

function jobs(): Map<DatasetId, LoadJobRecord> {
  const existing = g[JOBS_KEY]
  if (existing) return existing
  const created = new Map<DatasetId, LoadJobRecord>()
  g[JOBS_KEY] = created
  return created
}

const DATASET_IDS = new Set<string>(['tmdb', 'wikipedia', 'scifact', 'custom'])

export interface StartLoadJobResult {
  alreadyRunning: boolean
}

export function startLoadJob(request: LoadDatasetRequest): StartLoadJobResult {
  if (!DATASET_IDS.has(request.datasetId)) {
    throw new Error(`Unknown dataset: "${String(request.datasetId)}"`)
  }
  const existing = jobs().get(request.datasetId)
  if (existing?.running) return { alreadyRunning: true }

  const record: LoadJobRecord = {
    datasetId: request.datasetId,
    status: { datasetId: request.datasetId, phase: 'fetching' },
    running: true,
    controller: new AbortController(),
  }
  jobs().set(request.datasetId, record)
  void runLoadJob(record, request)
  return { alreadyRunning: false }
}

async function runLoadJob(record: LoadJobRecord, request: LoadDatasetRequest): Promise<void> {
  try {
    const backend = await getBackend()
    const onProgress = (payload: unknown) => {
      const progress = payload as DatasetLoadProgress
      if (progress.datasetId !== record.datasetId) return
      record.status = progress
    }
    backend.subscribe('progress', onProgress)
    try {
      await backend.loadDataset(request, { signal: record.controller.signal })
      record.status = { datasetId: record.datasetId, phase: 'complete' }
    } finally {
      backend.unsubscribe('progress', onProgress)
    }
  } catch (err) {
    record.status = {
      datasetId: record.datasetId,
      phase: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    record.running = false
  }
}

/** Latest status per dataset, including terminal results kept for reattaching
 * pages. The registry holds at most one record per dataset. */
export function listLoadJobs(): DatasetLoadProgress[] {
  return Array.from(jobs().values(), record => record.status)
}

export function cancelLoadJob(datasetId: string): boolean {
  const record = jobs().get(datasetId as DatasetId)
  if (!record || !record.running) return false
  record.controller.abort(new Error('The load was cancelled'))
  return true
}
