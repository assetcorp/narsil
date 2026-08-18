import type * as React from 'react'
import { useCallback } from 'react'
import { type DetectedField, fieldNameError, isDocumentIdField } from '../lib/schema-detector'

const FIELD_TYPES = ['string', 'number', 'boolean', 'enum', 'string[]', 'number[]'] as const

const SUPPORTED_LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
  { code: 'ee', name: 'Ewe' },
  { code: 'zu', name: 'Zulu' },
  { code: 'tw', name: 'Twi' },
  { code: 'yo', name: 'Yoruba' },
  { code: 'sw', name: 'Swahili' },
  { code: 'ha', name: 'Hausa' },
  { code: 'dag', name: 'Dagbani' },
  { code: 'ig', name: 'Igbo' },
]

export const INDEX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const NOT_APPLICABLE = '—'

const DISPLAY_SELECT_CLASS =
  'h-8 w-full cursor-pointer rounded-md border bg-transparent px-2 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30'

interface SchemaEditorProps {
  fields: DetectedField[]
  documents: Record<string, unknown>[]
  indexName: string
  language: string
  titleField: string | null
  bodyField: string | null
  onFieldsChange: (fields: DetectedField[]) => void
  onIndexNameChange: (name: string) => void
  onLanguageChange: (lang: string) => void
  onTitleFieldChange: (field: string | null) => void
  onBodyFieldChange: (field: string | null) => void
}

function validateIndexName(name: string): string | null {
  if (name.length === 0) return 'Name is required'
  if (name.length > 64) return 'Name must be 64 characters or fewer'
  if (!INDEX_NAME_PATTERN.test(name)) return 'Use lowercase letters, numbers, and hyphens only'
  return null
}

function FieldRow({
  field,
  fieldIndex,
  onTypeChange,
  onSearchableToggle,
}: {
  field: DetectedField
  fieldIndex: number
  onTypeChange: (fieldIndex: number, newType: string) => void
  onSearchableToggle: (fieldIndex: number) => void
}) {
  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onTypeChange(fieldIndex, e.target.value)
    },
    [onTypeChange, fieldIndex],
  )

  const handleSearchableToggle = useCallback(() => {
    onSearchableToggle(fieldIndex)
  }, [onSearchableToggle, fieldIndex])

  const nameError = fieldNameError(field.name)
  const isDocumentId = isDocumentIdField(field.name)

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30">
      <td className="px-3 py-1.5">
        <span className={`font-mono ${nameError ? 'text-destructive' : 'text-foreground'}`}>{field.name}</span>
        {nameError && <span className="block text-[10px] text-destructive">{nameError}</span>}
      </td>
      <td className="px-3 py-1.5">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">{field.detectedType}</span>
      </td>
      <td className="px-3 py-1.5">
        {isDocumentId ? (
          <span className="text-muted-foreground">Document ID</span>
        ) : (
          <select
            value={field.overrideType ?? field.detectedType}
            onChange={handleTypeChange}
            disabled={nameError !== null}
            className="h-6 cursor-pointer rounded border bg-transparent px-1 text-xs outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {FIELD_TYPES.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="px-3 py-1.5 text-center">
        {isDocumentId ? (
          <span className="text-muted-foreground">{NOT_APPLICABLE}</span>
        ) : (
          <input
            type="checkbox"
            checked={field.searchable}
            onChange={handleSearchableToggle}
            disabled={nameError !== null}
            className="size-3.5 cursor-pointer rounded accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
        )}
      </td>
    </tr>
  )
}

export function SchemaEditor({
  fields,
  documents,
  indexName,
  language,
  titleField,
  bodyField,
  onFieldsChange,
  onIndexNameChange,
  onLanguageChange,
  onTitleFieldChange,
  onBodyFieldChange,
}: SchemaEditorProps) {
  const nameError = validateIndexName(indexName)
  const preview = documents.slice(0, 3)
  const previewFields = fields.slice(0, 6)
  const rejectedFields = fields.filter(field => fieldNameError(field.name) !== null)
  const hasDocumentIdField = fields.some(field => isDocumentIdField(field.name))
  const hasIndexableField = fields.some(field => !isDocumentIdField(field.name) && fieldNameError(field.name) === null)

  function handleTypeChange(fieldIndex: number, newType: string) {
    const updated = fields.map((f, i) => {
      if (i !== fieldIndex) return f
      return { ...f, overrideType: newType === f.detectedType ? null : newType }
    })
    onFieldsChange(updated)
  }

  function handleSearchableToggle(fieldIndex: number) {
    const updated = fields.map((f, i) => {
      if (i !== fieldIndex) return f
      return { ...f, searchable: !f.searchable }
    })
    onFieldsChange(updated)
  }

  const handleIndexNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onIndexNameChange(e.target.value)
    },
    [onIndexNameChange],
  )

  const handleLanguageChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onLanguageChange(e.target.value)
    },
    [onLanguageChange],
  )

  const handleTitleFieldChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onTitleFieldChange(e.target.value === '' ? null : e.target.value)
    },
    [onTitleFieldChange],
  )

  const handleBodyFieldChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onBodyFieldChange(e.target.value === '' ? null : e.target.value)
    },
    [onBodyFieldChange],
  )

  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        <div className="flex-1">
          <label htmlFor="custom-index-name" className="mb-1 block text-xs font-medium">
            Index name
          </label>
          <input
            id="custom-index-name"
            type="text"
            value={indexName}
            onChange={handleIndexNameChange}
            maxLength={64}
            className="h-8 w-full rounded-md border bg-transparent px-2.5 font-mono text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
            placeholder="my-dataset"
          />
          {nameError && <p className="mt-0.5 text-[10px] text-destructive">{nameError}</p>}
        </div>

        <div className="w-full sm:w-40">
          <label htmlFor="custom-language" className="mb-1 block text-xs font-medium">
            Language
          </label>
          <select
            id="custom-language"
            value={language}
            onChange={handleLanguageChange}
            className="h-8 w-full cursor-pointer rounded-md border bg-transparent px-2 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
          >
            {SUPPORTED_LANGUAGES.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium">Result display</span>
        <p className="mb-2 text-[10px] text-muted-foreground">
          Search results show the title first, then the body text. Choose None for the title when your documents have no
          headline, and the body text leads instead.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
          <div className="flex-1">
            <label htmlFor="custom-title-field" className="mb-1 block text-xs font-medium">
              Title field
            </label>
            <select
              id="custom-title-field"
              value={titleField ?? ''}
              onChange={handleTitleFieldChange}
              className={DISPLAY_SELECT_CLASS}
            >
              <option value="">None</option>
              {fields.map(field => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1">
            <label htmlFor="custom-body-field" className="mb-1 block text-xs font-medium">
              Body field
            </label>
            <select
              id="custom-body-field"
              value={bodyField ?? ''}
              onChange={handleBodyFieldChange}
              className={DISPLAY_SELECT_CLASS}
            >
              {fields.map(field => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono font-medium text-foreground">{documents.length.toLocaleString()}</span>
        <span>documents</span>
        <span className="text-border">|</span>
        <span className="font-mono font-medium text-foreground">{fields.length}</span>
        <span>fields detected</span>
      </div>

      <div>
        <span className="mb-2 block text-xs font-medium">Field Configuration</span>
        {rejectedFields.length > 0 && (
          <p className="mb-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            Narsil cannot index {rejectedFields.length === 1 ? 'this field' : 'these fields'}:{' '}
            <span className="font-mono">{rejectedFields.map(field => field.name).join(', ')}</span>. Rename the
            {rejectedFields.length === 1 ? ' column' : ' columns'} in your file and upload it again.
          </p>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Field</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Detected</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-3 py-2 text-center font-medium text-muted-foreground">Searchable</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field, i) => (
                <FieldRow
                  key={field.name}
                  field={field}
                  fieldIndex={i}
                  onTypeChange={handleTypeChange}
                  onSearchableToggle={handleSearchableToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
        {!hasIndexableField && (
          <p className="mt-2 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            This file has no field Narsil can index. Add at least one column besides{' '}
            <span className="font-mono">id</span> and upload it again.
          </p>
        )}
        {hasDocumentIdField && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Narsil uses <span className="font-mono">id</span> as the document identifier, so it stays out of the schema
            and keeps your saved relevance marks pointing at the same documents after a reload.
          </p>
        )}
      </div>

      {preview.length > 0 && (
        <div>
          <span className="mb-2 block text-xs font-medium">Preview (first {preview.length} rows)</span>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b bg-muted/50">
                  {previewFields.map(f => (
                    <th
                      key={f.name}
                      className="max-w-[140px] truncate px-2.5 py-1.5 text-left font-mono font-medium text-muted-foreground"
                    >
                      {f.name}
                    </th>
                  ))}
                  {fields.length > 6 && (
                    <th className="px-2.5 py-1.5 text-left font-mono font-medium text-muted-foreground">...</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {preview.map((doc, rowIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable key
                  <tr key={rowIdx} className="border-b last:border-b-0">
                    {previewFields.map(f => {
                      const val = doc[f.name]
                      const display =
                        val === null || val === undefined ? '' : Array.isArray(val) ? val.join(', ') : String(val)
                      return (
                        <td key={f.name} className="max-w-[140px] truncate px-2.5 py-1.5 text-muted-foreground">
                          {display}
                        </td>
                      )
                    })}
                    {fields.length > 6 && <td className="px-2.5 py-1.5 text-muted-foreground">...</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
