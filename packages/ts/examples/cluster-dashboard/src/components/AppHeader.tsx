import { cn } from '@delali/narsil-example-shared'
import { ThemeToggle } from '@delali/narsil-example-shared/components/layout/ThemeToggle'
import type { StreamState } from '../hooks/use-cluster-stream'

interface AppHeaderProps {
  stream: StreamState
  allocationVersion: number | null
  indexName: string
  pending: string | null
}

const STREAM_LABEL: Record<StreamState, string> = {
  connecting: 'connecting',
  live: 'watching etcd',
  offline: 'stream lost',
}

const STREAM_CLASS: Record<StreamState, string> = {
  connecting: 'text-chart-3',
  live: 'text-muted-foreground',
  offline: 'text-destructive',
}

export function AppHeader({ stream, allocationVersion, indexName, pending }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1400px] items-center justify-between gap-6 px-4 lg:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-base font-bold tracking-tight">Narsil cluster</h1>
          <p className="hidden truncate text-sm text-muted-foreground md:block">
            Three nodes, one etcd coordinator, and a link you can cut between any pair of them
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-4 font-mono text-xs">
          <span className="hidden truncate text-muted-foreground lg:block">{pending ?? `index ${indexName}`}</span>
          <span className="hidden text-muted-foreground tabular-nums sm:block">
            allocation v{allocationVersion ?? 0}
          </span>
          <span
            className={cn('uppercase tracking-wider', STREAM_CLASS[stream], stream === 'connecting' && 'animate-pulse')}
            aria-live="polite"
          >
            {STREAM_LABEL[stream]}
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
