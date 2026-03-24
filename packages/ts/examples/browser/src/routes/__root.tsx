import type { DatasetId } from '@delali/narsil-example-shared'
import {
  AppDispatchContext,
  AppStateContext,
  appReducer,
  BackendContext,
  createInitialState,
} from '@delali/narsil-example-shared'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { useEffect, useReducer, useRef } from 'react'
import Footer from '../components/Footer'
import Header from '../components/Header'
import appCss from '../styles.css?url'
import { WorkerBackend } from '../worker/bridge'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Narsil - Browser Example' },
      {
        name: 'description',
        content: 'Interactive full-text search running entirely in your browser via Web Workers and IndexedDB.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
  if (indexName === 'cranfield') return 'cranfield'
  return 'custom'
}

function RootLayout() {
  const backendRef = useRef<WorkerBackend | null>(null)
  if (!backendRef.current) {
    backendRef.current = new WorkerBackend()
  }
  const backend = backendRef.current
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState)

  useEffect(() => {
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
  }, [backend])

  return (
    <BackendContext value={backend}>
      <AppStateContext value={state}>
        <AppDispatchContext value={dispatch}>
          <div className="flex min-h-dvh flex-col">
            <Header />
            <main className="flex-1">
              <Outlet />
            </main>
            <Footer />
          </div>
        </AppDispatchContext>
      </AppStateContext>
    </BackendContext>
  )
}
