import { INDEX_NAME_PATTERN, SchemaEditor } from '@delali/narsil-example-shared/components/SchemaEditor'
import { parseFile } from '@delali/narsil-example-shared/lib/file-parser'
import { buildSchema, type DetectedField, detectSchema } from '@delali/narsil-example-shared/lib/schema-detector'
import { FileUp, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

const MAX_FILE_SIZE = 50 * 1024 * 1024

export interface CustomDatasetConfig {
  documents: Record<string, unknown>[]
  schema: Record<string, string>
  indexName: string
  language: string
}

interface CustomConfigProps {
  onReady: (config: CustomDatasetConfig | null) => void
}

export function CustomConfig({ onReady }: CustomConfigProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [documents, setDocuments] = useState<Record<string, unknown>[] | null>(null)
  const [fields, setFields] = useState<DetectedField[]>([])
  const [indexName, setIndexName] = useState('')
  const [language, setLanguage] = useState('en')

  function emitConfig(docs: Record<string, unknown>[], f: DetectedField[], name: string, lang: string) {
    if (!name || name.length > 64 || !INDEX_NAME_PATTERN.test(name)) {
      onReady(null)
      return
    }
    const schema = buildSchema(f)
    onReady({ documents: docs, schema, indexName: name, language: lang })
  }

  function handleFieldsChange(updated: DetectedField[]) {
    setFields(updated)
    if (documents) emitConfig(documents, updated, indexName, language)
  }

  function handleIndexNameChange(name: string) {
    setIndexName(name)
    if (documents) emitConfig(documents, fields, name, language)
  }

  function handleLanguageChange(lang: string) {
    setLanguage(lang)
    if (documents) emitConfig(documents, fields, indexName, lang)
  }

  function processFile(file: File) {
    if (file.size > MAX_FILE_SIZE) {
      setParseError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`)
      onReady(null)
      return
    }

    setParseError(null)
    setFileName(file.name)

    const baseName =
      file.name
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64) || 'custom'
    setIndexName(baseName)

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = reader.result as string
        const docs = parseFile(text, file.name)
        const detected = detectSchema(docs)
        setDocuments(docs)
        setFields(detected)
        emitConfig(docs, detected, baseName, language)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setParseError(msg)
        setDocuments(null)
        setFields([])
        onReady(null)
      }
    }
    reader.onerror = () => {
      setParseError('Failed to read file')
      onReady(null)
    }
    reader.readAsText(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }

  function handleBrowseClick() {
    inputRef.current?.click()
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-sm font-medium">Upload your data</span>
        <p className="text-sm text-muted-foreground">
          Drag and drop a JSON or CSV file, or click to browse. Narsil will auto-detect the schema and let you choose
          which fields to index.
        </p>
      </div>
      <input ref={inputRef} type="file" accept=".json,.csv" className="hidden" onChange={handleFileChange} />
      <button
        type="button"
        className={`flex h-32 items-center justify-center rounded-lg border-2 border-dashed transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/50'}`}
        onClick={handleBrowseClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="text-center text-sm text-muted-foreground">
          {fileName ? (
            <>
              <FileUp className="mx-auto mb-2 size-5 text-primary" />
              <span className="font-medium text-foreground">{fileName}</span>
            </>
          ) : (
            <>
              <Upload className="mx-auto mb-2 size-5" />
              <span>Drop JSON or CSV here, or click to browse</span>
            </>
          )}
        </div>
      </button>

      {parseError && <p className="text-xs text-destructive">{parseError}</p>}

      {documents && fields.length > 0 && (
        <SchemaEditor
          fields={fields}
          documents={documents}
          indexName={indexName}
          language={language}
          onFieldsChange={handleFieldsChange}
          onIndexNameChange={handleIndexNameChange}
          onLanguageChange={handleLanguageChange}
        />
      )}
    </div>
  )
}
