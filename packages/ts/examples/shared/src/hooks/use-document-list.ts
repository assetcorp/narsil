import { useCallback, useEffect, useRef, useState } from 'react'
import type { ListedDocument, NarsilBackend } from '../backend'

export const DOCUMENT_PAGE_SIZE = 20
export const DOCUMENT_PAGE_SIZES = [10, 20, 50, 100]

export interface DocumentListRequest {
  pageSize: number
  filters?: Record<string, unknown>
  sort?: Record<string, 'asc' | 'desc'>
}

export interface DocumentListState {
  documents: ListedDocument[]
  total: number
  page: number
  elapsed: number
  hasLoaded: boolean
  isLoading: boolean
  error: string | null
}

const EMPTY_STATE: DocumentListState = {
  documents: [],
  total: 0,
  page: 0,
  elapsed: 0,
  hasLoaded: false,
  isLoading: false,
  error: null,
}

export function useDocumentList(backend: NarsilBackend, indexName: string | null, request: DocumentListRequest) {
  const { pageSize, filters, sort } = request
  const [state, setState] = useState<DocumentListState>(EMPTY_STATE)
  const cursors = useRef<Array<string | undefined>>([undefined])
  const requestCounter = useRef(0)
  const loadedIndex = useRef<string | null>(null)

  const fetchPage = useCallback(
    async (page: number) => {
      if (!indexName) return
      const cursor = cursors.current[page]
      if (page > 0 && cursor === undefined) return

      const id = ++requestCounter.current
      setState(s => ({ ...s, isLoading: true, error: null }))

      try {
        const response = await backend.listDocuments({ indexName, cursor, limit: pageSize, filters, sort })
        if (id !== requestCounter.current) return
        cursors.current[page + 1] = response.cursor ?? undefined
        setState({
          documents: response.documents,
          total: response.total,
          page,
          elapsed: response.elapsed,
          hasLoaded: true,
          isLoading: false,
          error: null,
        })
      } catch (err) {
        if (id !== requestCounter.current) return
        setState(s => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [backend, indexName, pageSize, filters, sort],
  )

  useEffect(() => {
    requestCounter.current++
    cursors.current = [undefined]
    const isSameIndex = loadedIndex.current === indexName
    loadedIndex.current = indexName
    if (!indexName) {
      setState(EMPTY_STATE)
      return
    }
    if (!isSameIndex) setState(EMPTY_STATE)
    fetchPage(0)
  }, [indexName, fetchPage])

  const setPage = useCallback(
    (page: number) => {
      if (page < 0) return
      fetchPage(page)
    },
    [fetchPage],
  )

  return { ...state, pageSize, setPage }
}
