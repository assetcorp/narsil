import type { DatasetId, DatasetLoadProgress } from '@delali/narsil-example-shared'
import { scifact, tmdb, wikipedia } from '@delali/narsil-example-shared'
import { BookOpen, Check, Film, Globe, Loader2, Settings2, Trash2, TriangleAlert, Upload } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Progress } from '#/components/ui/progress'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#/components/ui/sheet'
import type { EngineStatusPhase } from '#/lib/engine-status'

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

export interface DatasetMeta {
  id: DatasetId
  title: string
  description: string
  icon: typeof Film
  license?: string
  sheetDescription: string
}

export const datasetMeta: DatasetMeta[] = [
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
    id: 'scifact',
    title: 'SciFact',
    description:
      'Scientific fact-checking collection from the BEIR benchmark with 5,183 research abstracts, 300 claim queries, and expert relevance judgments for measuring retrieval quality.',
    icon: BookOpen,
    license: 'CC BY 4.0 / ODC-By 1.0',
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
  enginePhase: EngineStatusPhase
  progress: DatasetLoadProgress | undefined
  onLoad: (datasetId: DatasetId) => void
  onRemove: (datasetId: DatasetId) => void
  configContent: React.ReactNode
  loadDisabled: boolean
}

export function DatasetCard({
  ds,
  loaded,
  loading,
  restoring,
  enginePhase,
  progress,
  onLoad,
  onRemove,
  configContent,
  loadDisabled,
}: DatasetCardProps) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const Icon = ds.icon
  const busy = loading || restoring || enginePhase === 'checking' || enginePhase === 'starting'
  const engineFailed = enginePhase === 'error'

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
        {ds.id === 'scifact' && (
          <div className="mt-3 flex gap-3 text-xs text-muted-foreground">
            <span>{scifact.docCount} docs</span>
            <span>{scifact.queryCount} queries</span>
          </div>
        )}
      </CardContent>

      {progress && progress.phase !== 'complete' && <ProgressBar progress={progress} />}

      <CardFooter>
        {busy && (
          <Button type="button" variant="outline" className="w-full" disabled>
            <Loader2 className="size-3.5 animate-spin" />
            {loading ? 'Loading...' : 'Restoring...'}
          </Button>
        )}
        {!busy && engineFailed && (
          <Button type="button" variant="outline" className="w-full" disabled>
            <TriangleAlert className="size-3.5" />
            Server unavailable
          </Button>
        )}
        {!busy && !engineFailed && (
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
