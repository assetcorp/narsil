import { cn } from '#/lib/utils'
import type { DeviceSyncView } from '#/worker/protocol'

interface StatusPresentation {
  label: string
  dot: string
  pulse: boolean
}

const OPENING: StatusPresentation = { label: 'Opening this device', dot: 'bg-muted-foreground', pulse: true }
const PAUSED: StatusPresentation = { label: 'Paused', dot: 'bg-chart-3', pulse: false }
const OFFLINE: StatusPresentation = { label: 'Offline, working locally', dot: 'bg-destructive', pulse: false }
const LIVE: StatusPresentation = { label: 'Syncing live', dot: 'bg-chart-2', pulse: true }
const CONNECTING: StatusPresentation = { label: 'Connecting', dot: 'bg-chart-3', pulse: true }

function presentation(session: DeviceSyncView | null, online: boolean): StatusPresentation {
  if (session === null) return OPENING
  if (session.connection === 'stopped') return PAUSED
  if (!online) return OFFLINE
  return session.connection === 'connected' ? LIVE : CONNECTING
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  )
}

export function SyncStatusStrip({ session, online }: { session: DeviceSyncView | null; online: boolean }) {
  const shown = presentation(session, online)
  return (
    <section
      aria-label="Sync status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card/60 px-4 py-3 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('size-2 rounded-full', shown.dot, shown.pulse && 'animate-pulse motion-reduce:animate-none')}
          aria-hidden="true"
        />
        <span className="text-sm font-medium" data-testid="sync-connection">
          {shown.label}
        </span>
      </div>
      <Metric label="Queued to push" value={String(session?.queuedWrites ?? 0)} testId="sync-queued-writes" />
      <Metric label="Server position" value={session?.serverPosition?.toString() ?? '-'} />
    </section>
  )
}
