import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadSummary } from '#/lib/chat/types'
import { useAskThreads } from './use-ask-threads'

const { listThreadsFn, loadThreadFn, deleteThreadFn } = vi.hoisted(() => ({
  listThreadsFn: vi.fn(),
  loadThreadFn: vi.fn(),
  deleteThreadFn: vi.fn(),
}))

vi.mock('#/lib/server-fns', () => ({ listThreadsFn, loadThreadFn, deleteThreadFn }))

function storedSummary(id: string, title: string): ThreadSummary {
  return { id, title, indexName: 'wikipedia-en', createdAt: 1, updatedAt: 1, messageCount: 2 }
}

describe('useAskThreads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listThreadsFn.mockResolvedValue([])
  })

  it('shows a new conversation in the sidebar list as soon as it begins', async () => {
    const { result } = renderHook(() => useAskThreads())
    await waitFor(() => expect(listThreadsFn).toHaveBeenCalledTimes(1))

    act(() => {
      result.current.beginThread('t1', 'What led to the American Civil War?', 'wikipedia-en')
    })

    expect(result.current.threads).toHaveLength(1)
    expect(result.current.threads[0]).toMatchObject({
      id: 't1',
      title: 'What led to the American Civil War?',
      indexName: 'wikipedia-en',
      messageCount: 0,
    })
    expect(result.current.isThreadNew('t1')).toBe(true)
  })

  it('applies a mid-stream generated title to a thread that only exists optimistically', async () => {
    const { result } = renderHook(() => useAskThreads())
    await waitFor(() => expect(listThreadsFn).toHaveBeenCalledTimes(1))

    act(() => {
      result.current.beginThread('t1', 'What led to the American Civil War?', 'wikipedia-en')
      result.current.applyTitle('t1', 'Causes of the American Civil War')
    })

    expect(result.current.threads[0].title).toBe('Causes of the American Civil War')
  })

  it('prepends the new conversation above stored ones', async () => {
    listThreadsFn.mockResolvedValue([storedSummary('stored', 'Older conversation')])
    const { result } = renderHook(() => useAskThreads())
    await waitFor(() => expect(result.current.threads).toHaveLength(1))

    act(() => {
      result.current.beginThread('t2', 'A new question', 'wikipedia-en')
    })

    expect(result.current.threads.map(thread => thread.id)).toEqual(['t2', 'stored'])
    expect(result.current.isThreadNew('stored')).toBe(false)
  })

  it('leaves a stored thread untouched when beginThread reuses its id', async () => {
    listThreadsFn.mockResolvedValue([storedSummary('stored', 'Stored title')])
    const { result } = renderHook(() => useAskThreads())
    await waitFor(() => expect(result.current.threads).toHaveLength(1))

    act(() => {
      result.current.beginThread('stored', 'Provisional title', 'tmdb-10k')
    })

    expect(result.current.threads).toHaveLength(1)
    expect(result.current.threads[0].title).toBe('Stored title')
    expect(result.current.threads[0].indexName).toBe('wikipedia-en')
    expect(result.current.isThreadNew('stored')).toBe(false)
  })
})
