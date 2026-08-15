import { NarsilProvider, useIndexes } from '@delali/narsil/react'
import {
  IndexWorkspaceContext,
  type SearchRunners,
  SearchRunnersContext,
  useWorkspace,
} from '@delali/narsil-example-shared'
import { CommandPaletteProvider } from '@delali/narsil-example-shared/components/CommandPalette'
import { Footer } from '@delali/narsil-example-shared/components/layout/Footer'
import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import Header from '#/components/Header'
import ServerStatusBanner from '#/components/ServerStatusBanner'
import { narsilClient } from '#/lib/narsil/browser-client'
import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`

const INDEX_REFRESH_MS = 10_000

const SEARCH_RUNNERS: SearchRunners = {
  query: (indexName, params, signal) => narsilClient.query(indexName, params, { signal }),
  suggest: (indexName, params, signal) => narsilClient.suggest(indexName, params, { signal }),
}

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

function AppShell() {
  const indexes = useIndexes({ refreshIntervalMs: INDEX_REFRESH_MS, keepPreviousData: true })
  const source = useMemo(
    () => ({ data: indexes.data, isLoading: indexes.isLoading, error: indexes.error, refresh: indexes.refresh }),
    [indexes.data, indexes.isLoading, indexes.error, indexes.refresh],
  )
  const workspace = useWorkspace(source)

  const navigate = useNavigate()
  const handleNavigate = useCallback((to: string) => navigate({ to }), [navigate])
  const handleSearch = useCallback((term: string) => navigate({ to: '/search', search: { q: term } }), [navigate])

  return (
    <IndexWorkspaceContext value={workspace}>
      <SearchRunnersContext value={SEARCH_RUNNERS}>
        <CommandPaletteProvider navigate={handleNavigate} onSearch={handleSearch}>
          <div className="flex min-h-dvh flex-col">
            <Header />
            <ServerStatusBanner isConnecting={indexes.isLoading} error={workspace.error} />
            <main className="flex-1">
              <Outlet />
            </main>
            <Footer />
          </div>
        </CommandPaletteProvider>
      </SearchRunnersContext>
    </IndexWorkspaceContext>
  )
}

function RootLayout() {
  return (
    <NarsilProvider client={narsilClient}>
      <AppShell />
    </NarsilProvider>
  )
}
