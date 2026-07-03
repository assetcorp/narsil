import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelLoadJob, listLoadJobs, startLoadJob } from '../src/lib/load-jobs'

/* No NARSIL_SERVER_URL is configured here, so a started job fails once it
 * tries to reach the backend; that exercises the full lifecycle (running ->
 * terminal, record retained) without starting any server. */

const originalUrl = process.env.NARSIL_SERVER_URL

beforeEach(() => {
  delete process.env.NARSIL_SERVER_URL
})

afterEach(() => {
  if (originalUrl !== undefined) process.env.NARSIL_SERVER_URL = originalUrl
})

describe('load jobs', () => {
  it('rejects an unknown dataset id', () => {
    expect(() => startLoadJob({ datasetId: 'nonsense' } as never)).toThrow('Unknown dataset')
  })

  it('returns false when cancelling a dataset with no running job', () => {
    expect(cancelLoadJob('tmdb')).toBe(false)
  })

  it('runs a job to a terminal state and keeps the record observable', async () => {
    const result = startLoadJob({ datasetId: 'scifact' })
    expect(result.alreadyRunning).toBe(false)

    const initial = listLoadJobs().find(job => job.datasetId === 'scifact')
    expect(initial?.phase).toBe('fetching')

    await vi.waitFor(() => {
      const job = listLoadJobs().find(entry => entry.datasetId === 'scifact')
      expect(job?.phase).toBe('error')
    })

    const terminal = listLoadJobs().find(job => job.datasetId === 'scifact')
    expect(terminal?.error).toContain('NARSIL_SERVER_URL')
    expect(cancelLoadJob('scifact')).toBe(false)
  })
})
