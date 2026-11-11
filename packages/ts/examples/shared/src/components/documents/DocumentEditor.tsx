import type { AnyDocument } from '@delali/narsil'
import { Loader2 } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useState } from 'react'
import { useEngineActions } from '../../engine-actions'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const MAX_DOCUMENT_ID_LENGTH = 512
const JSON_INDENT = 2
const EMPTY_DOCUMENT_TEXT = '{\n  \n}'

export interface DocumentEditorProps {
  indexName: string
  documentId: string | null
  vectorPaths: ReadonlySet<string>
  onDone: () => void
}

function withoutVectors(document: AnyDocument, vectorPaths: ReadonlySet<string>): AnyDocument {
  const copy: AnyDocument = {}
  for (const [key, value] of Object.entries(document)) {
    if (!vectorPaths.has(key)) copy[key] = value
  }
  return copy
}

function parseDocument(text: string): AnyDocument | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return `The document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'The document has to be a JSON object, such as { "name": "Accra" }.'
  }
  return parsed as AnyDocument
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function DocumentEditor({ indexName, documentId, vectorPaths, onDone }: DocumentEditorProps) {
  const actions = useEngineActions()
  const [id, setId] = useState(documentId ?? '')
  const [text, setText] = useState(documentId === null ? EMPTY_DOCUMENT_TEXT : '')
  const [isLoading, setIsLoading] = useState(documentId !== null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (documentId === null) return
    let cancelled = false
    actions
      .getDocument(indexName, documentId)
      .then(document => {
        if (cancelled) return
        if (document === undefined) {
          setError(`The index holds no document "${documentId}" any more.`)
          return
        }
        setText(JSON.stringify(withoutVectors(document, vectorPaths), null, JSON_INDENT))
      })
      .catch(err => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [actions, indexName, documentId, vectorPaths])

  const handleIdChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setId(event.target.value)
  }, [])

  const handleTextChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
  }, [])

  const handleSave = useCallback(async () => {
    const trimmedId = id.trim()
    if (trimmedId.length === 0 || trimmedId.length > MAX_DOCUMENT_ID_LENGTH) {
      setError(`Give the document an ID of 1 to ${MAX_DOCUMENT_ID_LENGTH} characters.`)
      return
    }
    const document = parseDocument(text)
    if (typeof document === 'string') {
      setError(document)
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await actions.saveDocument(indexName, trimmedId, document)
      actions.onChanged(indexName)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }, [actions, id, indexName, onDone, text])

  const handleRemove = useCallback(async () => {
    if (documentId === null) return
    setIsSaving(true)
    setError(null)
    try {
      await actions.removeDocument(indexName, documentId)
      actions.onChanged(indexName)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }, [actions, documentId, indexName, onDone])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Reading the document
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="document-editor-id">
        Document ID
        <Input
          id="document-editor-id"
          value={id}
          onChange={handleIdChange}
          disabled={documentId !== null}
          className="font-mono text-xs"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium" htmlFor="document-editor-json">
        Fields as JSON
        <textarea
          id="document-editor-json"
          value={text}
          onChange={handleTextChange}
          spellCheck={false}
          rows={16}
          className="rounded-md border bg-card p-2 font-mono text-xs"
        />
      </label>
      {vectorPaths.size > 0 ? (
        <p className="text-xs text-muted-foreground">
          The editor leaves out {[...vectorPaths].join(', ')}. When you save, the index embeds the text again.
        </p>
      ) : null}
      {error === null ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave} disabled={isSaving}>
          {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save document
        </Button>
        {documentId === null ? null : (
          <Button type="button" variant="destructive" size="sm" onClick={handleRemove} disabled={isSaving}>
            Delete document
          </Button>
        )}
      </div>
    </div>
  )
}
