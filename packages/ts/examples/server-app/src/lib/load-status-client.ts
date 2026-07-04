import type { DatasetLoadProgress } from '@delali/narsil-example-shared/types'

const LOAD_POLL_MS = 750

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function fetchLoadJobs(signal?: AbortSignal): Promise<DatasetLoadProgress[]> {
  const response = await fetch('/api/load-status', { signal, cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`The load status request failed with status ${response.status}`)
  }
  const body = (await response.json()) as { jobs?: DatasetLoadProgress[] }
  return Array.isArray(body.jobs) ? body.jobs : []
}

export async function requestLoadCancel(datasetId: string): Promise<void> {
  await fetch('/api/load-cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId }),
  })
}

/**
 * Polls the job registry until the dataset's load reaches a terminal state,
 * reporting each status change. Resolves on completion and throws on failure,
 * mirroring what awaiting the load directly used to do. A fetch that fails
 * (dev server briefly unreachable) keeps polling; a response without the job
 * means the app server restarted and took the job with it.
 */
export async function watchLoadJob(
  datasetId: string,
  onProgress: (progress: DatasetLoadProgress) => void,
): Promise<void> {
  let lastReported = ''
  for (;;) {
    let job: DatasetLoadProgress | undefined
    let statusKnown = false
    try {
      const jobsList = await fetchLoadJobs()
      statusKnown = true
      job = jobsList.find(entry => entry.datasetId === datasetId)
    } catch {
      // Poll again; the dev server may be mid-restart.
    }

    if (statusKnown && !job) {
      throw new Error('The load is no longer running; the app server restarted while it was in progress.')
    }

    if (job) {
      const serialized = JSON.stringify(job)
      if (serialized !== lastReported) {
        lastReported = serialized
        onProgress(job)
      }
      if (job.phase === 'complete') return
      if (job.phase === 'error') {
        throw new Error(job.error ?? 'The dataset failed to load')
      }
    }

    await delay(LOAD_POLL_MS)
  }
}
