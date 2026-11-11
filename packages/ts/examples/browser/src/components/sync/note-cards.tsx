import { Check, Pencil, Plus } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useCallback, useId, useState } from 'react'
import { Button } from '#/components/ui/button'
import { Card, CardContent } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'
import { MAX_NOTE_BODY_LENGTH, MAX_NOTE_TITLE_LENGTH, SHORT_NOTE_ID_LENGTH } from './constants'
import { errorText } from './use-notes'

export interface Note {
  id: string
  title: string
  body: string
}

export type SaveNote = (id: string, title: string, body: string) => Promise<void>

function NoteForm({
  label,
  initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  label: string
  initial: { title: string; body: string }
  submitLabel: string
  onSave: (title: string, body: string) => Promise<void>
  onCancel?: () => void
}) {
  const titleId = useId()
  const bodyId = useId()
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const changeTitle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value)
    setSaved(false)
  }, [])
  const changeBody = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value)
    setSaved(false)
  }, [])
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setSaving(true)
      setFailure(null)
      onSave(title.trim(), body)
        .then(() => {
          if (onCancel !== undefined) return
          setTitle('')
          setBody('')
          setSaved(true)
        })
        .catch(error => setFailure(errorText(error)))
        .finally(() => setSaving(false))
    },
    [title, body, onSave, onCancel],
  )

  return (
    <form aria-label={label} className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-xs font-medium text-muted-foreground">
          Title
        </label>
        <Input
          id={titleId}
          required
          maxLength={MAX_NOTE_TITLE_LENGTH}
          value={title}
          onChange={changeTitle}
          disabled={saving}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={bodyId} className="text-xs font-medium text-muted-foreground">
          Note text
        </label>
        <textarea
          id={bodyId}
          className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          maxLength={MAX_NOTE_BODY_LENGTH}
          value={body}
          onChange={changeBody}
          disabled={saving}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
          {saving ? 'Saving' : submitLabel}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <output className="flex items-center gap-1 text-xs text-muted-foreground">
          {saved ? (
            <>
              <Check className="size-3.5 text-chart-2" aria-hidden="true" />
              Saved on this device
            </>
          ) : null}
        </output>
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </form>
  )
}

export function NewNoteCard({ onSave }: { onSave: SaveNote }) {
  const [open, setOpen] = useState(false)
  const openForm = useCallback(() => setOpen(true), [])
  const saveNew = useCallback((title: string, body: string) => onSave(crypto.randomUUID(), title, body), [onSave])
  return (
    <Card className="gap-0 border-dashed border-primary/25 py-4 shadow-none">
      <CardContent className="px-4">
        {open ? (
          <NoteForm label="New note" initial={{ title: '', body: '' }} submitLabel="Save note" onSave={saveNew} />
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-24 w-full flex-col gap-2 text-muted-foreground"
            onClick={openForm}
          >
            <Plus className="size-5" aria-hidden="true" />
            New note
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export function NoteCard({ note, onSave }: { note: Note; onSave: SaveNote }) {
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const startEditing = useCallback(() => {
    setEditing(true)
    setSaved(false)
  }, [])
  const stopEditing = useCallback(() => setEditing(false), [])
  const saveEdit = useCallback(
    async (title: string, body: string) => {
      await onSave(note.id, title, body)
      setEditing(false)
      setSaved(true)
    },
    [note.id, onSave],
  )
  return (
    <li data-note-id={note.id}>
      <Card
        className={cn(
          'h-full gap-0 py-4 duration-300 animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none',
          editing && 'ring-2 ring-ring/40',
        )}
      >
        <CardContent className="flex h-full flex-col gap-3 px-4">
          {editing ? (
            <NoteForm
              label={`Edit ${note.title}`}
              initial={note}
              submitLabel="Save note"
              onSave={saveEdit}
              onCancel={stopEditing}
            />
          ) : (
            <>
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-sm leading-snug font-semibold break-words">{note.title}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${note.title}`}
                  onClick={startEditing}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              </div>
              {note.body.length > 0 ? (
                <p className="line-clamp-5 text-sm leading-relaxed break-words whitespace-pre-line text-muted-foreground">
                  {note.body}
                </p>
              ) : null}
              <p className="mt-auto flex items-center gap-1.5 font-mono text-xs text-muted-foreground/80">
                {note.id.slice(0, SHORT_NOTE_ID_LENGTH)}
                {saved ? (
                  <output className="flex items-center gap-1 font-sans">
                    <Check className="size-3.5 text-chart-2" aria-hidden="true" />
                    Saved on this device
                  </output>
                ) : null}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </li>
  )
}
