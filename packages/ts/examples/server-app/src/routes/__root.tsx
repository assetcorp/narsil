import type { DatasetId, DatasetLoadProgress } from '@delali/narsil-example-shared'
import {
  AppDispatchContext,
  AppStateContext,
  appReducer,
  BackendContext,
  createInitialState,
} from '@delali/narsil-example-shared'
import { CommandPaletteProvider } from '@delali/narsil-example-shared/components/CommandPalette'
import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import EngineStatusBanner from '../components/EngineStatusBanner'
import Footer from '../components/Footer'
import Header from '../components/Header'
import { type EngineStatus, EngineStatusContext, fetchEngineStatus } from '../lib/engine-status'
import { fetchLoadJobs, watchLoadJob } from '../lib/load-status-client'
import { RpcBackend } from '../lib/rpc-backend'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Narsil - Server App Example' },
      { name: 'description', content: 'A web application backed by the Narsil HTTP server over REST.' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: asset('narsil.svg') },
      { rel: 'icon', href: asset('narsil.ico'), sizes: 'any' },
      { rel: 'apple-touch-icon', href: asset('narsil-apple.png') },
      { rel: 'manifest', href: asset('manifest.json') },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: inline theme init prevents FOUC */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function inferDatasetId(indexName: string): DatasetId {
  if (indexName.startsWith('tmdb-')) return 'tmdb'
  if (indexName.startsWith('wikipedia-')) return 'wikipedia'
  if (indexName === 'scifact') return 'scifact'
  return 'custom'
}

const ENGINE_STATUS_POLL_MS = 1_000

function RootLayout() {
  const backendRef = useRef<RpcBackend | null>(null)
  if (!backendRef.current) {
    backendRef.current = new RpcBackend()
  }
  const backend = backendRef.current
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState)
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ phase: 'checking' })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    async function poll(): Promise<void> {
      while (!cancelled) {
        try {
          const status = await fetchEngineStatus(controller.signal)
          if (cancelled) return
          setEngineStatus(status)
          if (status.phase !== 'starting') return
        } catch {
          if (cancelled) return
        }
        await new Promise(resolve => setTimeout(resolve, ENGINE_STATUS_POLL_MS))
      }
    }

    void poll()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (engineStatus.phase === 'checking' || engineStatus.phase === 'starting') return
    if (engineStatus.phase === 'error') {
      dispatch({ type: 'SET_RESTORING', payload: false })
      return
    }
    backend
      .listIndexes()
      .then(indexes => {
        for (const idx of indexes) {
          dispatch({
            type: 'INDEX_READY',
            payload: {
              name: idx.name,
              datasetId: inferDatasetId(idx.name),
              documentCount: idx.documentCount,
              language: idx.language,
            },
          })
        }
      })
      .catch(() => {})
      .finally(() => {
        dispatch({ type: 'SET_RESTORING', payload: false })
      })
  }, [backend, engineStatus.phase])

  /* Loads run as server-side jobs, so one that was started before this page
   * loaded (or survived a reload) is picked up here and followed to the end. */
  useEffect(() => {
    if (engineStatus.phase !== 'ready') return
    let cancelled = false

    const followJob = async (job: DatasetLoadProgress): Promise<void> => {
      dispatch({ type: 'SET_LOADING', payload: job })
      try {
        await watchLoadJob(job.datasetId, progress => {
          if (!cancelled) dispatch({ type: 'SET_LOADING', payload: progress })
        })
        if (cancelled) return
        const indexes = await backend.listIndexes()
        if (cancelled) return
        for (const idx of indexes) {
          dispatch({
            type: 'INDEX_READY',
            payload: {
              name: idx.name,
              datasetId: inferDatasetId(idx.name),
              documentCount: idx.documentCount,
              language: idx.language,
            },
          })
        }
      } catch (err) {
        if (cancelled) return
        dispatch({
          type: 'LOADING_ERROR',
          payload: { datasetId: job.datasetId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }

    void fetchLoadJobs()
      .then(runningJobs => {
        if (cancelled) return
        for (const job of runningJobs) {
          if (job.phase === 'fetching' || job.phase === 'indexing') void followJob(job)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [backend, engineStatus.phase])

  const navigate = useNavigate()

  const handleNavigate = useCallback((to: string) => navigate({ to }), [navigate])

  const handleSearch = useCallback((term: string) => navigate({ to: '/search', search: { q: term } }), [navigate])

  return (
    <BackendContext value={backend}>
      <AppStateContext value={state}>
        <AppDispatchContext value={dispatch}>
          <EngineStatusContext value={engineStatus}>
            <CommandPaletteProvider navigate={handleNavigate} onSearch={handleSearch}>
              <div className="flex min-h-dvh flex-col">
                <Header />
                <EngineStatusBanner status={engineStatus} />
                <main className="flex-1">
                  <Outlet />
                </main>
                <Footer />
              </div>
            </CommandPaletteProvider>
          </EngineStatusContext>
        </AppDispatchContext>
      </AppStateContext>
    </BackendContext>
  )
}
