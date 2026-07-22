import { useCallback, useEffect, useRef, useState } from 'react'
import { parseStoredMessages } from '#/lib/chat/serialization'
import type { StoredThread, ThreadSummary } from '#/lib/chat/types'
import { deleteThreadFn, listThreadsFn, loadThreadFn } from '#/lib/server-fns'

export interface AskThreadsController {
  threads: ThreadSummary[]
  activeThreadId: string | null
  threadIdRef: React.RefObject<string | null>
  setActiveThreadId: (id: string | null) => void
  ensureThreadId: () => string
  beginThread: (id: string, title: string, indexName: string) => void
  isThreadNew: (id: string) => boolean
  refresh: () => void
  applyTitle: (threadId: string, title: string) => void
  loadThread: (id: string) => Promise<StoredThread | null>
  removeThread: (id: string) => Promise<void>
}

export function useAskThreads(): AskThreadsController {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(null)
  const threadIdRef = useRef<string | null>(null)

  const setActiveThreadId = useCallback((id: string | null) => {
    threadIdRef.current = id
    setActiveThreadIdState(id)
  }, [])

  const refresh = useCallback(() => {
    listThreadsFn()
      .then(setThreads)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const ensureThreadId = useCallback(() => {
    const current = threadIdRef.current
    if (current) return current
    const id = crypto.randomUUID()
    setActiveThreadId(id)
    return id
  }, [setActiveThreadId])

  const newThreadIdsRef = useRef<Set<string>>(new Set())

  const beginThread = useCallback((id: string, title: string, indexName: string) => {
    setThreads(prev => {
      if (prev.some(thread => thread.id === id)) return prev
      newThreadIdsRef.current.add(id)
      const now = Date.now()
      return [{ id, title, indexName, createdAt: now, updatedAt: now, messageCount: 0 }, ...prev]
    })
  }, [])

  const isThreadNew = useCallback((id: string) => newThreadIdsRef.current.has(id), [])

  const applyTitle = useCallback((threadId: string, title: string) => {
    setThreads(prev => {
      const target = prev.find(thread => thread.id === threadId)
      if (!target || target.title === title) return prev
      return prev.map(thread => (thread.id === threadId ? { ...thread, title } : thread))
    })
  }, [])

  const loadThread = useCallback(async (id: string): Promise<StoredThread | null> => {
    const thread = await loadThreadFn({ data: { id } })
    if (!thread) return null
    try {
      const { messagesJson, ...summary } = thread
      return { ...summary, messages: parseStoredMessages(messagesJson) }
    } catch (error) {
      console.error(`[ask] failed to read the stored conversation ${id}:`, error)
      return null
    }
  }, [])

  const removeThread = useCallback(async (id: string) => {
    await deleteThreadFn({ data: { id } })
    setThreads(prev => prev.filter(thread => thread.id !== id))
  }, [])

  return {
    threads,
    activeThreadId,
    threadIdRef,
    setActiveThreadId,
    ensureThreadId,
    beginThread,
    isThreadNew,
    refresh,
    applyTitle,
    loadThread,
    removeThread,
  }
}
