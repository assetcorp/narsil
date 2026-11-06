import { useIndexWorkspace } from '@delali/narsil-example-shared'
import { MAX_SYNC_INDEX_NAME_LENGTH } from '@delali/narsil-example-shared/lib/bounded-read'
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from 'react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { SERVER_APP_PATH_PREFIX } from '#/lib/server-app-path'
import { narsilWorker } from '#/worker/bridge'
import type { DeviceSyncView } from '#/worker/protocol'

const SYNC_STATUS_POLL_MS = 1_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function SessionRow({ session, onStopped }: { session: DeviceSyncView; onStopped: (next: DeviceSyncView[]) => void }) {
  const [stopError, setStopError] = useState<string | null>(null)

  const handleStop = useCallback(() => {
    setStopError(null)
    narsilWorker
      .call('stopSync', [session.indexName])
      .then(onStopped)
      .catch((err: unknown) => setStopError(errorText(err)))
  }, [session.indexName, onStopped])

  return (
    <li className="rounded-lg border p-4" data-testid="sync-session" data-index-name={session.indexName}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">{session.indexName}</p>
          <p className="truncate text-xs text-muted-foreground">{session.serverUrl}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleStop}>
          Stop sync
        </Button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <dt className="text-muted-foreground">Connection</dt>
        <dd data-testid="sync-connection">{session.connection}</dd>
        <dt className="text-muted-foreground">Writes waiting to upload</dt>
        <dd data-testid="sync-queued-writes">{session.queuedWrites}</dd>
        <dt className="text-muted-foreground">Server epoch</dt>
        <dd className="truncate font-mono">{session.epoch ?? 'none yet'}</dd>
        <dt className="text-muted-foreground">Refused writes</dt>
        <dd data-testid="sync-refused-writes">{session.refusedWrites}</dd>
      </dl>
      {session.lastError === null ? null : (
        <p className="mt-2 text-xs text-destructive" data-testid="sync-last-error">
          {session.lastError}
        </p>
      )}
      {stopError === null ? null : (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {stopError}
        </p>
      )}
    </li>
  )
}

export function SyncPanel() {
  const { activeIndexName } = useIndexWorkspace()
  const [indexName, setIndexName] = useState(activeIndexName ?? '')
  const [sessions, setSessions] = useState<DeviceSyncView[]>([])
  const [isStarting, setIsStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = () => {
      narsilWorker
        .call('syncStatus', [])
        .then(next => {
          if (!cancelled) setSessions(next)
        })
        .catch(() => undefined)
    }
    read()
    const timer = setInterval(read, SYNC_STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const handleIndexNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setIndexName(event.target.value)
  }, [])

  const handleStart = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const name = indexName.trim()
      if (name.length === 0) {
        setStartError('Give the name of an index that the server app holds.')
        return
      }
      setIsStarting(true)
      setStartError(null)
      narsilWorker
        .call('startSync', [
          {
            indexName: name,
            serverUrl: `${window.location.origin}${SERVER_APP_PATH_PREFIX}/api/narsil`,
            grantUrl: `${SERVER_APP_PATH_PREFIX}/api/sync-grant`,
          },
        ])
        .then(setSessions)
        .catch((err: unknown) => setStartError(errorText(err)))
        .finally(() => setIsStarting(false))
    },
    [indexName],
  )

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-1 text-3xl font-bold tracking-tight">Device Sync</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        This page keeps an index in this browser in step with the same index in the server app. Turn sync on for the
        index in the server app's Inspector first, under Manage. Edits that you make on the Documents page then upload
        to the server, and edits on the server arrive here over the sync feed. A second tab of this app sees every
        change and sends its edits through the tab that syncs.
      </p>

      <form className="mb-6 flex max-w-2xl flex-wrap items-end gap-3" onSubmit={handleStart}>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-medium" htmlFor="sync-index-name">
          Index to sync
          <Input
            id="sync-index-name"
            value={indexName}
            maxLength={MAX_SYNC_INDEX_NAME_LENGTH}
            onChange={handleIndexNameChange}
            placeholder="places"
          />
        </label>
        <Button type="submit" disabled={isStarting}>
          {isStarting ? 'Starting' : 'Start sync'}
        </Button>
      </form>

      {startError === null ? null : (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {startError}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">This tab syncs no index yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sessions.map(session => (
            <SessionRow key={session.indexName} session={session} onStopped={setSessions} />
          ))}
        </ul>
      )}
    </div>
  )
}
