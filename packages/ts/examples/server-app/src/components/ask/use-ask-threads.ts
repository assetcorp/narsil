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

  const applyTitle = useCallback((threadId: string, title: string) => {
    setThreads(prev => prev.map(thread => (thread.id === threadId ? { ...thread, title } : thread)))
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
    refresh,
    applyTitle,
    loadThread,
    removeThread,
  }
}
