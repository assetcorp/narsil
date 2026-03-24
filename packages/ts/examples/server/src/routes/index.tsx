import type { DatasetId, DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { cranfield, tmdb, useAppDispatch, useAppState, useBackend, wikipedia } from '@delali/narsil-example-shared'
import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Check, FileUp, Film, Globe, Loader2, Settings2, Upload } from 'lucide-react'
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

function TmdbConfig({ tier, setTier }: { tier: string; setTier: (t: string) => void }) {
  const tiers = tmdb.tiers.map(t => t.label)
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-2 block text-sm font-medium">Document tier</label>
        <div className="flex flex-wrap gap-2">
          {tiers.map(t => (
            <Button
              key={t}
              type="button"
              variant={tier === t ? 'default' : 'outline'}
              size="sm"
              className="font-mono text-xs"
              onClick={() => setTier(t)}
            >
              {t}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Larger tiers (50k+) are downloaded from GitHub Releases.</p>
      </div>
      <Separator />
      <div>
        <label className="mb-2 block text-sm font-medium">Indexed fields</label>
        <p className="text-xs text-muted-foreground">
          title, overview, tagline, genres, original_language, vote_average, popularity, runtime, revenue, release_year,
          production_countries, status
        </p>
      </div>
    </div>
  )
}

function WikiConfig({ selected, toggle }: { selected: Set<string>; toggle: (code: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-2 block text-sm font-medium">Languages</label>
        <div className="flex flex-wrap gap-2">
          {wikipedia.languages.map(({ code, name }) => (
            <Button
              key={code}
              type="button"
              variant={selected.has(code) ? 'default' : 'outline'}
              size="sm"
              className="text-xs"
              onClick={() => toggle(code)}
            >
              <span className="font-mono uppercase">{code}</span>
              <span className="ml-1 text-muted-foreground">{name}</span>
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Each language creates its own index with the correct tokenizer.
        </p>
      </div>
      <Separator />
      <div>
        <label className="mb-2 block text-sm font-medium">Text depth</label>
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

function CustomConfig({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)

  function handleFile(file: File | undefined) {
    if (!file) return
    setFileName(file.name)
    onFile(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-2 block text-sm font-medium">Upload your data</label>
        <p className="text-sm text-muted-foreground">
          Drag and drop a JSON or CSV file, or click to browse. Narsil will auto-detect the schema and let you choose
          which fields to index.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".json,.csv"
        className="hidden"
        onChange={e => handleFile(e.target.files?.[0])}
      />
      <button
        type="button"
        className={`flex h-32 items-center justify-center rounded-lg border-2 border-dashed transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/50'}`}
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
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
  configContent: React.ReactNode
}

function DatasetCard({ ds, loaded, loading, restoring, progress, onLoad, configContent }: DatasetCardProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const Icon = ds.icon
  const busy = loading || restoring

  function handleLoadClick() {
    setSheetOpen(false)
    setTimeout(() => onLoad(ds.id), 0)
  }

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
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant={loaded ? 'secondary' : 'outline'} className="w-full">
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
                <Button type="button" className="w-full" disabled={ds.id === 'custom'} onClick={handleLoadClick}>
                  {loaded ? 'Reload Dataset' : 'Load Dataset'}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
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
  const [customFile, setCustomFile] = useState<File | null>(null)

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
        case 'custom':
          return
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
            (datasetId === 'cranfield' && idx.name === 'cranfield')
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
    [backend, dispatch, tmdbTier, wikiLangs],
  )

  function isLoaded(datasetId: DatasetId): boolean {
    return state.indexes.some(idx => idx.datasetId === datasetId)
  }

  function isLoading(datasetId: DatasetId): boolean {
    const progress = state.loadingDatasets.get(datasetId)
    return !!progress && progress.phase !== 'complete' && progress.phase !== 'error'
  }

  const configContent: Record<DatasetId, React.ReactNode> = {
    tmdb: <TmdbConfig tier={tmdbTier} setTier={setTmdbTier} />,
    wikipedia: <WikiConfig selected={wikiLangs} toggle={toggleWikiLang} />,
    cranfield: <CranfieldConfig />,
    custom: <CustomConfig onFile={setCustomFile} />,
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <section className="mb-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Datasets</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose a dataset to index. Narsil runs on the server with filesystem persistence, so indexed data survives
          restarts. Configure the tier and fields, then explore search, relevance tuning, and quality benchmarks.
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
            configContent={configContent[ds.id]}
          />
        ))}
      </div>
    </div>
  )
}
