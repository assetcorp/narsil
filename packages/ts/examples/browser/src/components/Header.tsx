import { Link } from '@tanstack/react-router'
import { Search, FlaskConical, BarChart3, Inspect, Database, Lock, Check, Loader2 } from 'lucide-react'
import { useAppState } from '@delali/narsil-example-shared'
import type { TabId } from '@delali/narsil-example-shared'
import ThemeToggle from './ThemeToggle'
import { Badge } from '#/components/ui/badge'

const tabs: Array<{ to: string; label: string; icon: typeof Database; tabId: TabId }> = [
  { to: '/', label: 'Datasets', icon: Database, tabId: 'datasets' },
  { to: '/search', label: 'Search', icon: Search, tabId: 'search' },
  { to: '/relevance', label: 'Relevance', icon: FlaskConical, tabId: 'relevance' },
  { to: '/benchmark', label: 'Benchmark', icon: BarChart3, tabId: 'benchmark' },
  { to: '/inspector', label: 'Inspector', icon: Inspect, tabId: 'inspector' },
]

export default function Header() {
  const state = useAppState()

  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link to="/" className="flex items-center gap-2 text-foreground no-underline">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary">
            <span className="text-sm font-bold text-primary-foreground">N</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">Narsil</span>
          <Badge variant="secondary" className="text-[10px]">
            browser
          </Badge>
        </Link>

        <nav className="flex items-center gap-1">
          {tabs.map(({ to, label, icon: Icon, tabId }) => {
            const status = state.tabStatus[tabId]
            const isLocked = status === 'locked'

            return (
              <Link
                key={to}
                to={to}
                disabled={isLocked}
                className="relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-40 [&.active]:bg-secondary [&.active]:text-foreground"
                activeProps={{ className: 'active' }}
                activeOptions={{ exact: to === '/' }}
              >
                <Icon className="size-3.5" />
                <span className="hidden sm:inline">{label}</span>
                {isLocked && <Lock className="size-2.5" />}
                {status === 'ready' && tabId !== 'datasets' && (
                  <Check className="size-2.5 text-green-500" />
                )}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {state.loadingDatasets.size > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="hidden sm:inline">Loading...</span>
            </div>
          )}
          <ThemeToggle />
          <a
            href="https://github.com/assetcorp/narsil"
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="sr-only">GitHub</span>
            <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  )
}
