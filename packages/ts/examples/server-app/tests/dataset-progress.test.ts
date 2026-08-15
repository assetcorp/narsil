import type { TaskRecord } from '@delali/narsil/client'
import { describe, expect, it } from 'vitest'
import { taskByDataset, taskProgress } from '../src/lib/dataset-progress'

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'indexName' | 'status'>): TaskRecord {
  return {
    type: 'import',
    owner: 'test',
    createdAt: 1,
    ...overrides,
  }
}

describe('taskProgress', () => {
  it('reports a running import with the bytes the server has read', () => {
    const progress = taskProgress(
      task({
        id: 't1',
        indexName: 'scifact',
        status: 'running',
        progress: { indexed: 400, failed: 0, bytesProcessed: 2_000, bytesTotal: 8_000 },
      }),
    )

    expect(progress).toEqual({
      datasetId: 'scifact',
      phase: 'indexing',
      indexedDocs: 400,
      loadedBytes: 2_000,
      totalBytes: 8_000,
    })
  })

  it('reports a finished import as complete with what it indexed', () => {
    const progress = taskProgress(
      task({
        id: 't2',
        indexName: 'tmdb-10k',
        status: 'succeeded',
        result: { indexed: 10_000, failed: 0, errors: [], errorsTruncated: false },
      }),
    )

    expect(progress).toEqual({ datasetId: 'tmdb', phase: 'complete', indexedDocs: 10_000 })
  })

  it('carries the server message of a failed import', () => {
    const progress = taskProgress(
      task({
        id: 't3',
        indexName: 'wikipedia-en',
        status: 'failed',
        error: { code: 'EMBEDDING_FAILED', message: 'the embedding provider refused the batch' },
      }),
    )

    expect(progress).toEqual({
      datasetId: 'wikipedia',
      phase: 'error',
      error: 'the embedding provider refused the batch',
    })
  })

  it('reads a cancelled import as a stopped load rather than a failure of its own', () => {
    const progress = taskProgress(task({ id: 't4', indexName: 'scifact', status: 'cancelled' }))
    expect(progress).toEqual({ datasetId: 'scifact', phase: 'error', error: 'The load was stopped' })
  })
})

describe('taskByDataset', () => {
  it('follows the running import when a dataset builds several indexes', () => {
    const finished = task({ id: 'a', indexName: 'wikipedia-en', status: 'succeeded', createdAt: 20 })
    const running = task({ id: 'b', indexName: 'wikipedia-fr', status: 'running', createdAt: 10 })

    expect(taskByDataset([finished, running]).get('wikipedia')?.id).toBe('b')
  })

  it('falls back to the import that finished last', () => {
    const older = task({ id: 'a', indexName: 'wikipedia-en', status: 'succeeded', createdAt: 10 })
    const newer = task({ id: 'b', indexName: 'wikipedia-fr', status: 'failed', createdAt: 30 })

    expect(taskByDataset([older, newer]).get('wikipedia')?.id).toBe('b')
  })

  it('keeps one entry per dataset', () => {
    const chosen = taskByDataset([
      task({ id: 'a', indexName: 'scifact', status: 'running' }),
      task({ id: 'b', indexName: 'tmdb-1k', status: 'running' }),
      task({ id: 'c', indexName: 'my-upload', status: 'running' }),
    ])

    expect([...chosen.keys()].sort()).toEqual(['custom', 'scifact', 'tmdb'])
  })
})
