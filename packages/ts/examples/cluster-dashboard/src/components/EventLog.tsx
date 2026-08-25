import { cn } from '@delali/narsil-example-shared'
import { memo } from 'react'
import type { ClusterEvent, ClusterEventKind } from '../lib/cluster-events'

const KIND_CLASS: Record<ClusterEventKind, string> = {
  node: 'text-foreground',
  controller: 'text-chart-1',
  leadership: 'text-primary',
  replication: 'text-chart-3',
  link: 'text-muted-foreground',
  index: 'text-chart-2',
}

function clockOf(at: string): string {
  const parsed = new Date(at)
  return Number.isNaN(parsed.getTime()) ? '--:--:--' : parsed.toLocaleTimeString()
}

export const EventLog = memo(function EventLog({ events }: { events: ClusterEvent[] }) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-bold tracking-tight">What the cluster did</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every line below is a change the coordinator recorded, newest first.
      </p>

      {events.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing has changed since the dashboard connected.
        </p>
      ) : (
        <ol className="mt-4 flex max-h-96 flex-col gap-1.5 overflow-y-auto">
          {events.map(event => (
            <li key={event.id} className="flex gap-3 font-mono text-xs leading-relaxed">
              <span className="shrink-0 tabular-nums text-muted-foreground">{clockOf(event.at)}</span>
              <span className={cn('min-w-0', KIND_CLASS[event.kind])}>{event.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
})
