import type { DatasetId } from '@delali/narsil-example-shared'
import {
  AppDispatchContext,
  AppStateContext,
  appReducer,
  BackendContext,
  createInitialState,
} from '@delali/narsil-example-shared'
import { CommandPalette } from '@delali/narsil-example-shared/components/CommandPalette'
import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import Footer from '../components/Footer'
import Header from '../components/Header'
import { RpcBackend } from '../lib/rpc-backend'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Narsil - Server Example' },
      { name: 'description', content: 'Full-text search with server functions and filesystem persistence.' },
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
  if (indexName === 'cranfield') return 'cranfield'
  return 'custom'
}

function RootLayout() {
  const backendRef = useRef<RpcBackend | null>(null)
  if (!backendRef.current) {
    backendRef.current = new RpcBackend()
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

  const navigate = useNavigate()

  const handleNavigate = useCallback((to: string) => navigate({ to }), [navigate])

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
          <CommandPalette navigate={handleNavigate} />
        </AppDispatchContext>
      </AppStateContext>
    </BackendContext>
  )
}
