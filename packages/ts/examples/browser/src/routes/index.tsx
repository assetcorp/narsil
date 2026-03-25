import type { DatasetId, DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { cranfield, tmdb, useAppDispatch, useAppState, useBackend, wikipedia } from '@delali/narsil-example-shared'
import { INDEX_NAME_PATTERN, SchemaEditor } from '@delali/narsil-example-shared/components/SchemaEditor'
import { parseFile } from '@delali/narsil-example-shared/lib/file-parser'
import { buildSchema, type DetectedField, detectSchema } from '@delali/narsil-example-shared/lib/schema-detector'
import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Check, FileUp, Film, Globe, Loader2, Settings2, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Progress } from '#/components/ui/progress'
import { Separator } from '#/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#/components/ui/sheet'

export const Route = createFileRoute('/')({ component: HomePage })

function TierButton({ label, active, onSelect }: { label: string; active: boolean; onSelect: (t: string) => void }) {
  const handleClick = useCallback(() => onSelect(label), [label, onSelect])
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      className="font-mono text-xs"
      onClick={handleClick}
    >
      {label}
    </Button>
  )
}

function TmdbConfig({ tier, setTier }: { tier: string; setTier: (t: string) => void }) {
  const tiers = tmdb.tiers.map(t => t.label)
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-sm font-medium">Document tier</span>
        <div className="flex flex-wrap gap-2">
          {tiers.map(t => (
            <TierButton key={t} label={t} active={tier === t} onSelect={setTier} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Larger tiers (50k+) are downloaded from GitHub Releases.</p>
      </div>
      <Separator />
      <div>
        <span className="mb-2 block text-sm font-medium">Indexed fields</span>
        <p className="text-xs text-muted-foreground">
          title, overview, tagline, genres, original_language, vote_average, popularity, runtime, revenue, release_year,
          production_countries, status
        </p>
      </div>
    </div>
  )
}

function LangButton({
  code,
  name,
  active,
  onToggle,
}: {
  code: string
  name: string
  active: boolean
  onToggle: (code: string) => void
}) {
  const handleClick = useCallback(() => onToggle(code), [code, onToggle])
  return (
    <Button type="button" variant={active ? 'default' : 'outline'} size="sm" className="text-xs" onClick={handleClick}>
      <span className="font-mono uppercase">{code}</span>
      <span className="ml-1 text-muted-foreground">{name}</span>
    </Button>
  )
}

function WikiConfig({ selected, toggle }: { selected: Set<string>; toggle: (code: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-sm font-medium">Languages</span>
        <div className="flex flex-wrap gap-2">
          {wikipedia.languages.map(({ code, name }) => (
            <LangButton key={code} code={code} name={name} active={selected.has(code)} onToggle={toggle} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Each language creates its own index with the correct tokenizer.
        </p>
      </div>
      <Separator />
      <div>
        <span className="mb-2 block text-sm font-medium">Text depth</span>
        <p className="text-xs text-muted-foreground">
          Lead section (~2k chars) or full article. Configurable after loading.
        </p>
      </div>
    </div>
  )
}

function CranfieldConfig() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          The Cranfield collection is a fixed dataset: 1,400 aeronautics abstracts, 225 queries, and expert relevance
          judgments. No configuration needed.
        </p>
      </div>
      <Separator />
      <div className="flex gap-6 text-sm">
        <div>
          <span className="block font-mono text-lg font-semibold">1,400</span>
          <span className="text-xs text-muted-foreground">documents</span>
        </div>
        <div>
          <span className="block font-mono text-lg font-semibold">225</span>
          <span className="text-xs text-muted-foreground">queries</span>
        </div>
        <div>
          <span className="block font-mono text-lg font-semibold">1,837</span>
          <span className="text-xs text-muted-foreground">judgments</span>
        </div>
      </div>
    </div>
  )
}

const MAX_FILE_SIZE = 50 * 1024 * 1024

interface CustomConfigProps {
  onReady: (
    config: {
      documents: Record<string, unknown>[]
      schema: Record<string, string>
      indexName: string
      language: string
    } | null,
  ) => void
}

function CustomConfig({ onReady }: CustomConfigProps) {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ProgressBar({ progress }: { progress: DatasetLoadProgress }) {
  let percent = 0
  let label = ''

  switch (progress.phase) {
    case 'fetching':
      if (progress.totalBytes && progress.loadedBytes) {
        percent = Math.round((progress.loadedBytes / progress.totalBytes) * 100)
        label = `Downloading ${formatBytes(progress.loadedBytes)} of ${formatBytes(progress.totalBytes)}`
      } else {
        label = 'Downloading...'
      }
      break
    case 'indexing':
      if (progress.totalDocs && progress.indexedDocs) {
        percent = Math.round((progress.indexedDocs / progress.totalDocs) * 100)
        label = `Indexing ${progress.indexedDocs.toLocaleString()} of ${progress.totalDocs.toLocaleString()}`
      } else {
        label = 'Indexing...'
      }
      break
    case 'complete':
      percent = 100
      label = 'Done'
      break
    case 'error':
      label = progress.error ?? 'Failed'
      break
  }

  return (
    <div className="flex flex-col gap-1.5 px-6 pb-2">
      <Progress value={percent} />
      <p className={`text-xs ${progress.phase === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{label}</p>
    </div>
  )
}

interface DatasetMeta {
  id: DatasetId
  title: string
  description: string
  icon: typeof Film
  license?: string
  sheetDescription: string
}

const datasetMeta: DatasetMeta[] = [
  {
    id: 'tmdb',
    title: 'TMDB Movies',
    description:
      'Search across movie titles, overviews, and taglines with faceted filtering by genre, language, and release year.',
    icon: Film,
    license: 'CC0',
    sheetDescription: 'Configure movie dataset tier and indexing options.',
  },
  {
    id: 'wikipedia',
    title: 'Multilingual Wikipedia',
    description:
      'Full-text search across Wikipedia articles in 10+ languages. Tests tokenization, stemming, and cross-language ranking.',
    icon: Globe,
    license: 'CC-BY-SA',
    sheetDescription: 'Select languages and text depth.',
  },
  {
    id: 'cranfield',
    title: 'Cranfield Collection',
    description:
      'Classic IR test collection with 1,400 documents, 225 queries, and human relevance judgments for measuring retrieval quality.',
    icon: BookOpen,
    license: 'Public Domain',
    sheetDescription: 'Fixed IR test collection.',
  },
  {
    id: 'custom',
    title: 'Your Dataset',
    description:
      'Upload JSON or CSV, auto-detect the schema, choose searchable fields, and build a custom index on the fly.',
    icon: Upload,
    sheetDescription: 'Upload and configure a custom dataset.',
  },
]

interface DatasetCardProps {
  ds: DatasetMeta
  loaded: boolean
  loading: boolean
  restoring: boolean
  progress: DatasetLoadProgress | undefined
  onLoad: (datasetId: DatasetId) => void
  onRemove: (datasetId: DatasetId) => void
  configContent: React.ReactNode
  loadDisabled: boolean
}

function DatasetCard({
  ds,
  loaded,
  loading,
  restoring,
  progress,
  onLoad,
  onRemove,
  configContent,
  loadDisabled,
}: DatasetCardProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const Icon = ds.icon
  const busy = loading || restoring

  function handleLoadClick() {
    setSheetOpen(false)
    setTimeout(() => onLoad(ds.id), 0)
  }

  const handleRemoveClick = useCallback(() => {
    onRemove(ds.id)
  }, [ds.id, onRemove])

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <Icon className="size-4 text-secondary-foreground" />
          </div>
          <div>
            <CardTitle className="text-base">
              {ds.title}
              {loaded && <Check className="ml-2 inline size-4 text-green-500" />}
            </CardTitle>
            {ds.license && (
              <Badge variant="outline" className="mt-1 text-[10px]">
                {ds.license}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="text-sm text-muted-foreground">{ds.description}</p>
        {ds.id === 'tmdb' && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tmdb.tiers.map(tier => (
              <Badge key={tier.label} variant="secondary" className="text-[10px] font-mono">
                {tier.label}
              </Badge>
            ))}
          </div>
        )}
        {ds.id === 'wikipedia' && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {wikipedia.languages.map(({ code }) => (
              <Badge key={code} variant="secondary" className="text-[10px] font-mono uppercase">
                {code}
              </Badge>
            ))}
          </div>
        )}
        {ds.id === 'cranfield' && (
          <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
            <span>{cranfield.docCount} docs</span>
            <span>{cranfield.queryCount} queries</span>
          </div>
        )}
      </CardContent>

      {progress && progress.phase !== 'complete' && <ProgressBar progress={progress} />}

      <CardFooter>
        {busy ? (
          <Button type="button" variant="outline" className="w-full" disabled>
            <Loader2 className="size-3.5 animate-spin" />
            {restoring ? 'Restoring...' : 'Loading...'}
          </Button>
        ) : (
          <div className="flex w-full gap-1.5">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button type="button" variant={loaded ? 'secondary' : 'outline'} className="flex-1">
                  {loaded ? (
                    <>
                      <Check className="size-3.5" />
                      Reconfigure
                    </>
                  ) : (
                    <>
                      <Settings2 className="size-3.5" />
                      Configure
                    </>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>{ds.title}</SheetTitle>
                  <SheetDescription>{ds.sheetDescription}</SheetDescription>
                </SheetHeader>
                <div className="px-4">{configContent}</div>
                <SheetFooter>
                  <Button type="button" className="w-full" disabled={loadDisabled} onClick={handleLoadClick}>
                    {loaded ? 'Reload Dataset' : 'Load Dataset'}
                  </Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
            {loaded && !busy && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                onClick={handleRemoveClick}
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only">Remove</span>
              </Button>
            )}
          </div>
        )}
      </CardFooter>
    </Card>
  )
}

function HomePage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  const [tmdbTier, setTmdbTier] = useState('10k')
  const [wikiLangs, setWikiLangs] = useState<Set<string>>(new Set(['en']))
  const [customConfig, setCustomConfig] = useState<{
    documents: Record<string, unknown>[]
    schema: Record<string, string>
    indexName: string
    language: string
  } | null>(null)

  useEffect(() => {
    const handler = (progress: DatasetLoadProgress) => {
      dispatch({ type: 'SET_LOADING', payload: progress })

      if (progress.phase === 'error') {
        dispatch({
          type: 'LOADING_ERROR',
          payload: { datasetId: progress.datasetId, error: progress.error ?? 'Unknown error' },
        })
      }
    }

    backend.subscribe('progress', handler)
    return () => backend.unsubscribe('progress', handler)
  }, [backend, dispatch])

  function toggleWikiLang(code: string) {
    setWikiLangs(prev => {
      const next = new Set(prev)
      if (next.has(code)) {
        next.delete(code)
      } else {
        next.add(code)
      }
      return next
    })
  }

  const handleLoad = useCallback(
    async (datasetId: DatasetId) => {
      let request: LoadDatasetRequest
      switch (datasetId) {
        case 'tmdb':
          request = { datasetId: 'tmdb', tier: tmdbTier }
          break
        case 'wikipedia':
          request = { datasetId: 'wikipedia', languages: [...wikiLangs] }
          break
        case 'cranfield':
          request = { datasetId: 'cranfield' }
          break
        case 'custom': {
          if (!customConfig) return
          request = {
            datasetId: 'custom',
            documents: customConfig.documents,
            schema: customConfig.schema,
            indexName: customConfig.indexName,
            language: customConfig.language,
          }
          break
        }
      }

      dispatch({
        type: 'SET_LOADING',
        payload: { datasetId, phase: 'fetching' },
      })

      try {
        await backend.loadDataset(request)
        const indexes = await backend.listIndexes()
        for (const idx of indexes) {
          if (
            (datasetId === 'tmdb' && idx.name.startsWith('tmdb-')) ||
            (datasetId === 'wikipedia' && idx.name.startsWith('wikipedia-')) ||
            (datasetId === 'cranfield' && idx.name === 'cranfield') ||
            (datasetId === 'custom' && customConfig && idx.name === customConfig.indexName)
          ) {
            dispatch({
              type: 'INDEX_READY',
              payload: {
                name: idx.name,
                datasetId,
                documentCount: idx.documentCount,
                language: idx.language,
              },
            })
          }
        }
      } catch (err) {
        dispatch({
          type: 'LOADING_ERROR',
          payload: { datasetId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    [backend, dispatch, tmdbTier, wikiLangs, customConfig],
  )

  const handleRemove = useCallback(
    async (datasetId: DatasetId) => {
      const indexesForDataset = state.indexes.filter(idx => idx.datasetId === datasetId)
      for (const idx of indexesForDataset) {
        try {
          await backend.deleteIndex(idx.name)
          dispatch({ type: 'REMOVE_INDEX', payload: idx.name })
        } catch {
          // Index may already be gone
        }
      }
    },
    [backend, dispatch, state.indexes],
  )

  function isLoaded(datasetId: DatasetId): boolean {
    return state.indexes.some(idx => idx.datasetId === datasetId)
  }

  function isLoading(datasetId: DatasetId): boolean {
    const progress = state.loadingDatasets.get(datasetId)
    return !!progress && progress.phase !== 'complete' && progress.phase !== 'error'
  }

  function isLoadDisabled(datasetId: DatasetId): boolean {
    if (datasetId === 'custom') return !customConfig
    return false
  }

  const configContent: Record<DatasetId, React.ReactNode> = {
    tmdb: <TmdbConfig tier={tmdbTier} setTier={setTmdbTier} />,
    wikipedia: <WikiConfig selected={wikiLangs} toggle={toggleWikiLang} />,
    cranfield: <CranfieldConfig />,
    custom: <CustomConfig onReady={setCustomConfig} />,
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <section className="mb-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Datasets</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose a dataset to index. Narsil runs entirely in your browser using a Web Worker, so your data never leaves
          the machine. Configure the tier and fields, then explore search, relevance tuning, and quality benchmarks.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {datasetMeta.map(ds => (
          <DatasetCard
            key={ds.id}
            ds={ds}
            loaded={isLoaded(ds.id)}
            loading={isLoading(ds.id)}
            restoring={state.restoring}
            progress={state.loadingDatasets.get(ds.id)}
            onLoad={handleLoad}
            onRemove={handleRemove}
            configContent={configContent[ds.id]}
            loadDisabled={isLoadDisabled(ds.id)}
          />
        ))}
      </div>
    </div>
  )
}
