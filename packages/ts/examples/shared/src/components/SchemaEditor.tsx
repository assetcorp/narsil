import type * as React from 'react'
import { useCallback } from 'react'
import type { DetectedField } from '../lib/schema-detector'

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

interface SchemaEditorProps {
  fields: DetectedField[]
  documents: Record<string, unknown>[]
  indexName: string
  language: string
  onFieldsChange: (fields: DetectedField[]) => void
  onIndexNameChange: (name: string) => void
  onLanguageChange: (lang: string) => void
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

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30">
      <td className="px-3 py-1.5">
        <span className="font-mono text-foreground">{field.name}</span>
      </td>
      <td className="px-3 py-1.5">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">{field.detectedType}</span>
      </td>
      <td className="px-3 py-1.5">
        <select
          value={field.overrideType ?? field.detectedType}
          onChange={handleTypeChange}
          className="h-6 cursor-pointer rounded border bg-transparent px-1 text-xs outline-none focus:border-primary"
        >
          {FIELD_TYPES.map(t => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-1.5 text-center">
        <input
          type="checkbox"
          checked={field.searchable}
          onChange={handleSearchableToggle}
          className="size-3.5 cursor-pointer rounded accent-primary"
        />
      </td>
    </tr>
  )
}

export function SchemaEditor({
  fields,
  documents,
  indexName,
  language,
  onFieldsChange,
  onIndexNameChange,
  onLanguageChange,
}: SchemaEditorProps) {
  const nameError = validateIndexName(indexName)
  const preview = documents.slice(0, 3)
  const previewFields = fields.slice(0, 6)

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

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono font-medium text-foreground">{documents.length.toLocaleString()}</span>
        <span>documents</span>
        <span className="text-border">|</span>
        <span className="font-mono font-medium text-foreground">{fields.length}</span>
        <span>fields detected</span>
      </div>

      <div>
        <span className="mb-2 block text-xs font-medium">Field Configuration</span>
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
