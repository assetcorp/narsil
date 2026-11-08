import type { AnyDocument } from '@delali/narsil'
import { readBoundedText } from '@delali/narsil-example-shared/lib/bounded-read'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as v from 'valibot'
import { SERVER_APP_PATH_PREFIX } from '#/lib/server-app-path'
import { NarsilWorkerClient } from '#/worker/bridge'
import { GRANT_TIMEOUT_MS, MAX_GRANT_RESPONSE_BYTES } from '#/worker/constants'
import type { DeviceSyncView } from '#/worker/protocol'
import { NOTES_PAGE_SIZE, NOTES_POLL_MS, NOTES_SPACE_KEY } from './constants'
import { deviceLockName, isValidNotesSpace } from './device-registry'

export interface NotesResult {
  count: number
  hits: Array<{ id: string; document: AnyDocument }>
}

export type NotesPhase = 'opening' | 'locked' | 'failed' | 'ready'

export type OpeningStage = 'code' | 'space' | 'engine' | 'sync'

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function claimNotesSpace(): Promise<string> {
  return navigator.locks.request(NOTES_SPACE_KEY, async () => {
    const existing = localStorage.getItem(NOTES_SPACE_KEY)
    if (!navigator.onLine && existing !== null && isValidNotesSpace(existing)) return existing
    const response = await fetch(`${SERVER_APP_PATH_PREFIX}/api/notes-space`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(GRANT_TIMEOUT_MS),
    })
    const text = await readBoundedText(response, MAX_GRANT_RESPONSE_BYTES)
    if (!response.ok || text === null) throw new Error("The server could not open this browser's notes space.")
    const parsed = v.parse(v.object({ space: v.pipe(v.string(), v.uuid()) }), JSON.parse(text))
    localStorage.setItem(NOTES_SPACE_KEY, parsed.space)
    return parsed.space
  })
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    updateOnline()
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [])
  return online
}

export function useNotes(device: string) {
  const [client, setClient] = useState<NarsilWorkerClient | null>(null)
  const [indexName, setIndexName] = useState('')
  const [phase, setPhase] = useState<NotesPhase>('opening')
  const [stage, setStage] = useState<OpeningStage>('code')
  const [failure, setFailure] = useState<string | null>(null)
  const [session, setSession] = useState<DeviceSyncView | null>(null)
  const [result, setResult] = useState<NotesResult | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [changingSync, setChangingSync] = useState(false)
  const online = useOnline()
  const syncChangePending = useRef(false)
  const currentTerm = useRef(term)
  currentTerm.current = term

  useEffect(() => {
    let cancelled = false
    let worker: NarsilWorkerClient | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let release: (() => void) | undefined
    const closed = new Promise<void>(resolve => {
      release = resolve
    })
    setClient(null)
    setPhase('opening')
    setStage('space')
    setFailure(null)
    setSession(null)
    setResult(null)
    setReadError(null)
    setControlError(null)
    const open = async () => {
      const space = await claimNotesSpace()
      if (cancelled) return
      const name = `demo-notes-${space}`
      await navigator.locks.request(deviceLockName(space, device), { ifAvailable: true }, async lock => {
        if (cancelled) return
        if (lock === null) {
          setPhase('locked')
          return
        }
        const opened = new NarsilWorkerClient(`${space}-${device}`)
        worker = opened
        setStage('engine')
        await opened.call('syncStatus', [])
        if (cancelled) return
        setStage('sync')
        const sessions = await opened.call('openNotes', [
          {
            indexName: name,
            deviceKey: device,
            serverUrl: `${window.location.origin}${SERVER_APP_PATH_PREFIX}/api/narsil`,
            grantUrl: `${SERVER_APP_PATH_PREFIX}/api/sync-grant`,
          },
        ])
        if (cancelled) return
        setIndexName(name)
        setSession(sessions[0] ?? null)
        setClient(opened)
        setPhase('ready')
        const readNotes = async (requested: string): Promise<NotesResult> => {
          if (requested.trim().length > 0) {
            return opened.call('query', [name, { term: requested, limit: NOTES_PAGE_SIZE }, { groupTotalField: null }])
          }
          const listed = await opened.call('listDocuments', [name, { limit: NOTES_PAGE_SIZE }])
          return { count: listed.total, hits: listed.documents }
        }
        const poll = async () => {
          try {
            const requested = currentTerm.current
            const [next, found] = await Promise.all([opened.call('syncStatus', []), readNotes(requested)])
            if (!cancelled) {
              setReadError(null)
              setSession(next[0] ?? null)
              if (requested === currentTerm.current) setResult(found)
            }
          } catch (error) {
            if (!cancelled) setReadError(errorText(error))
          }
          if (!cancelled) timer = setTimeout(poll, NOTES_POLL_MS)
        }
        void poll()
        await closed
      })
    }
    const openingTimer = setTimeout(() => {
      void open().catch(error => {
        worker?.close()
        if (cancelled) return
        setFailure(errorText(error))
        setPhase('failed')
      })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(openingTimer)
      clearTimeout(timer)
      worker?.close()
      release?.()
    }
  }, [device])

  const save = useCallback(
    async (id: string, title: string, body: string) => {
      if (client === null) throw new Error('Wait for this device to open.')
      await client.call('saveDocument', [indexName, id, { title, body }])
    },
    [client, indexName],
  )

  const setSyncEnabled = useCallback(
    (enabled: boolean) => {
      if (client === null || syncChangePending.current) return
      syncChangePending.current = true
      setChangingSync(true)
      setControlError(null)
      client
        .call('pauseSync', [indexName, !enabled])
        .then(next => setSession(next[0] ?? null))
        .catch(error => setControlError(errorText(error)))
        .finally(() => {
          syncChangePending.current = false
          setChangingSync(false)
        })
    },
    [client, indexName],
  )

  return {
    phase,
    stage,
    failure,
    session,
    result,
    term,
    setTerm,
    readError,
    controlError,
    save,
    setSyncEnabled,
    changingSync,
    online,
  }
}
