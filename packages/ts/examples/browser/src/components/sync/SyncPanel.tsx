import { useNavigate } from '@tanstack/react-router'
import { CloudOff, NotebookPen, Search, TriangleAlert } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useId, useState } from 'react'
import { Input } from '#/components/ui/input'
import { Separator } from '#/components/ui/separator'
import { Switch } from '#/components/ui/switch'
import { NOTES_PAGE_SIZE } from './constants'
import { DeviceDialog } from './device-dialog'
import { isValidDeviceName, rememberDevice } from './device-registry'
import { FailedScreen, LockedScreen, OnboardingScreen } from './device-screens'
import { NewNoteCard, type Note, NoteCard } from './note-cards'
import { Notice } from './notice'
import { OpeningProgress } from './opening-progress'
import { SyncStatusStrip } from './sync-status-strip'
import { type NotesResult, useNotes } from './use-notes'

function useOpenDevice(): (name: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (name: string) => {
      rememberDevice(name)
      void navigate({ to: '/sync', search: { device: name } })
    },
    [navigate],
  )
}

function notesFrom(result: NotesResult | null): Note[] {
  return (result?.hits ?? []).map(hit => ({
    id: hit.id,
    title: String(hit.document.title ?? ''),
    body: String(hit.document.body ?? ''),
  }))
}

function PageHeader({
  device,
  syncing,
  syncDisabled,
  onSyncChange,
  onPick,
}: {
  device: string
  syncing: boolean
  syncDisabled: boolean
  onSyncChange: (enabled: boolean) => void
  onPick: (name: string) => void
}) {
  const switchId = useId()
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <NotebookPen className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <h1 className="text-xl leading-tight font-bold tracking-tight">Personal notes</h1>
        <p className="text-sm text-muted-foreground">Search and edit offline, and sync between devices</p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <DeviceDialog currentDevice={device} onPick={onPick} />
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={syncing} disabled={syncDisabled} onCheckedChange={onSyncChange} />
          <label htmlFor={switchId} className="text-sm font-medium">
            Sync
          </label>
        </div>
      </div>
    </header>
  )
}

function NotesGrid({
  result,
  term,
  onSave,
}: {
  result: NotesResult | null
  term: string
  onSave: (id: string, title: string, body: string) => Promise<void>
}) {
  const notes = notesFrom(result)
  const count = result?.count ?? 0
  return (
    <section aria-label="Your notes" className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {result === null
          ? 'Reading notes'
          : term.trim().length > 0
            ? `${count} matching ${count === 1 ? 'note' : 'notes'}`
            : `${count} ${count === 1 ? 'note' : 'notes'} on this device`}
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NewNoteCard onSave={onSave} />
        <ul data-testid="notes-list" className="contents">
          {notes.map(note => (
            <NoteCard key={note.id} note={note} onSave={onSave} />
          ))}
        </ul>
        {result !== null && count === 0 ? (
          <p className="flex min-h-32 items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm text-muted-foreground">
            {term.trim().length > 0
              ? 'No notes match your search.'
              : 'Save your first note, then open another device to watch it arrive.'}
          </p>
        ) : null}
      </div>
      {count > NOTES_PAGE_SIZE ? (
        <p className="text-sm text-muted-foreground">
          Showing the first {NOTES_PAGE_SIZE} notes. Refine your search to find another one.
        </p>
      ) : null}
    </section>
  )
}

function NotesDevice({ device }: { device: string }) {
  const notes = useNotes(device)
  const openDevice = useOpenDevice()
  const [dismissedRefusals, setDismissedRefusals] = useState(0)
  const { session, online, setTerm } = notes
  const changeSearch = useCallback((event: ChangeEvent<HTMLInputElement>) => setTerm(event.target.value), [setTerm])
  const refusedWrites = session?.refusedWrites ?? 0
  const dismissRefusals = useCallback(() => setDismissedRefusals(refusedWrites), [refusedWrites])

  if (notes.phase === 'locked') return <LockedScreen name={device} onPick={openDevice} />
  if (notes.phase === 'failed') return <FailedScreen name={device} failure={notes.failure ?? 'Unknown failure'} />

  const ready = notes.phase === 'ready'
  const serverUnavailable = session?.connection === 'connecting' && online && session.lastError !== null
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <PageHeader
        device={device}
        syncing={session !== null && session.connection !== 'stopped'}
        syncDisabled={!ready || notes.changingSync}
        onSyncChange={notes.setSyncEnabled}
        onPick={openDevice}
      />
      <SyncStatusStrip session={session} online={online} />
      {notes.controlError === null ? null : (
        <Notice icon={<TriangleAlert />} tone="destructive" urgent title="Sync could not change">
          {notes.controlError}
        </Notice>
      )}
      {serverUnavailable ? (
        <Notice icon={<CloudOff />} title="The server is unavailable">
          Your edits stay on this device and upload when it reconnects.
        </Notice>
      ) : null}
      {refusedWrites > dismissedRefusals ? (
        <Notice icon={<TriangleAlert />} tone="destructive" urgent title="Sync is failing" onDismiss={dismissRefusals}>
          {session?.lastError}
        </Notice>
      ) : null}
      {ready ? (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor="notes-search" className="sr-only">
              Search notes
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="notes-search"
                type="search"
                value={notes.term}
                onChange={changeSearch}
                placeholder="Search titles and text on this device"
                className="h-10 pl-9"
              />
            </div>
            {notes.readError === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {notes.readError}
              </p>
            )}
          </div>
          <NotesGrid result={notes.result} term={notes.term} onSave={notes.save} />
        </>
      ) : (
        <OpeningProgress device={device} stage={notes.stage} />
      )}
    </div>
  )
}

export function SyncPanel({ device }: { device: string | undefined }) {
  const openDevice = useOpenDevice()
  const valid = device !== undefined && isValidDeviceName(device)
  useEffect(() => {
    if (valid) rememberDevice(device)
  }, [valid, device])
  if (!valid) return <OnboardingScreen rejectedName={device} onPick={openDevice} />
  return <NotesDevice key={device} device={device} />
}
