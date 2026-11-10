import { createContext, useContext, useEffect, useRef } from 'react'

export const IndexChangesContext = createContext(0)

export function useIndexChangeRevision(): number {
  return useContext(IndexChangesContext)
}

export function useRefreshOnChange(refresh: () => void): void {
  const revision = useIndexChangeRevision()
  const seen = useRef(revision)

  useEffect(() => {
    if (seen.current === revision) return
    seen.current = revision
    refresh()
  }, [revision, refresh])
}
