import { createFileRoute } from '@tanstack/react-router'
import { AppHeader } from '../components/AppHeader'
import { ErrorBanner } from '../components/ErrorBanner'
import { EventLog } from '../components/EventLog'
import { NodeBoard } from '../components/NodeBoard'
import { PartitionTable } from '../components/PartitionTable'
import { ReadProbePanel } from '../components/ReadProbePanel'
import { SetupPanel } from '../components/SetupPanel'
import { useDashboard } from '../hooks/use-dashboard'

function Dashboard() {
  const dashboard = useDashboard()
  const { snapshot, stream, events } = dashboard
  const busy = dashboard.pending !== null

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        stream={stream}
        allocationVersion={snapshot?.allocationVersion ?? null}
        indexName={snapshot?.indexName ?? 'forum-answers'}
        pending={dashboard.pending}
      />

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-4 py-6 lg:px-6">
        {dashboard.error === null ? null : (
          <ErrorBanner message={dashboard.error} onDismiss={dashboard.onDismissError} />
        )}

        {dashboard.streamError === null ? null : (
          <p className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
            The cluster stream stopped: {dashboard.streamError}
          </p>
        )}

        {snapshot === null ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            The dashboard is waiting for its first snapshot of the coordinator.
          </p>
        ) : (
          <>
            {snapshot.coordinatorError === null ? null : (
              <p className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
                The coordinator answered with an error: {snapshot.coordinatorError}
              </p>
            )}

            <NodeBoard snapshot={snapshot} onToggleLink={dashboard.onToggleLink} onHealLinks={dashboard.onHealLinks} />

            <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <PartitionTable snapshot={snapshot} />
              <EventLog events={events} />
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <ReadProbePanel nodes={snapshot.nodes} busy={busy} runAction={dashboard.runAction} />
              <SetupPanel
                indexName={snapshot.indexName}
                indexExists={snapshot.indexExists}
                provision={dashboard.provision}
                busy={busy}
                onProvision={dashboard.onProvision}
              />
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: Dashboard,
})
