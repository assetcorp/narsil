import type { DatasetId, DatasetLoadProgress } from '@delali/narsil-example-shared'
import { scifact, tmdb, wikipedia } from '@delali/narsil-example-shared'
import { BookOpen, FileText, Film, Globe, Loader2, Settings2, Trash2, TriangleAlert, Upload, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Progress } from '#/components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '#/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
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
    <div className="relative flex flex-col gap-1.5 px-6 pb-2">
      <Progress value={percent} />
      <p className={`text-xs ${progress.phase === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{label}</p>
    </div>
  )
}

export interface DatasetMeta {
  id: DatasetId
  kind: string
  title: string
  description: string
  icon: typeof Film
  license?: string
  sheetDescription: string
}

export const datasetMeta: DatasetMeta[] = [
  {
    id: 'tmdb',
    kind: 'Movies',
    title: 'TMDB Movies',
    description:
      'Search across movie titles, overviews, and taglines with faceted filtering by genre, language, and release year.',
    icon: Film,
    license: 'CC0',
    sheetDescription: 'Configure movie dataset tier and indexing options.',
  },
  {
    id: 'wikipedia',
    kind: 'Encyclopaedia',
    title: 'Multilingual Wikipedia',
    description:
      'Full-text search across Wikipedia articles in 10+ languages. Tests tokenization, stemming, and cross-language ranking.',
    icon: Globe,
    license: 'CC-BY-SA',
    sheetDescription: 'Select languages and text depth.',
  },
  {
    id: 'scifact',
    kind: 'Scientific claims',
    title: 'SciFact',
    description:
      'Scientific fact-checking collection from the BEIR benchmark with 5,183 research abstracts, 300 claim queries, and expert relevance judgments for measuring retrieval quality.',
    icon: BookOpen,
    license: 'CC BY 4.0 / ODC-By 1.0',
    sheetDescription: 'Fixed IR test collection.',
  },
  {
    id: 'custom',
    kind: 'Your upload',
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
  onView: (datasetId: DatasetId) => void
  onCancel: (datasetId: DatasetId) => void
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
  onView,
  onCancel,
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

  const handleConfigureClick = useCallback(() => {
    setSheetOpen(true)
  }, [])

  const handleRemoveClick = useCallback(() => {
    onRemove(ds.id)
  }, [ds.id, onRemove])

  const handleCancelClick = useCallback(() => {
    onCancel(ds.id)
  }, [ds.id, onCancel])

  const handleViewClick = useCallback(() => {
    onView(ds.id)
  }, [ds.id, onView])

  return (
    <Card className="relative flex flex-col overflow-hidden transition-shadow duration-300 hover:shadow-lg">
      <Icon
        aria-hidden="true"
        strokeWidth={1}
        className="icon-blend pointer-events-none absolute -right-4 -bottom-4 size-28 text-primary/10 dark:text-primary/15"
      />

      <CardHeader className="relative">
        <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">{ds.kind}</span>
        <CardTitle className="text-lg font-bold tracking-tight">{ds.title}</CardTitle>
        {loaded && (
          <CardAction>
            <Badge variant="outline" className="gap-1.5 text-[10px]">
              <span className="size-1.5 rounded-full bg-chart-2" />
              Indexed
            </Badge>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="relative flex-1">
        <p className="text-sm leading-relaxed text-muted-foreground">{ds.description}</p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {ds.id === 'tmdb' &&
            tmdb.tiers.map(tier => (
              <Badge key={tier.label} variant="secondary" className="font-mono text-[10px]">
                {tier.label}
              </Badge>
            ))}
          {ds.id === 'wikipedia' &&
            wikipedia.languages.map(({ code }) => (
              <Badge key={code} variant="secondary" className="font-mono text-[10px] uppercase">
                {code}
              </Badge>
            ))}
          {ds.id === 'scifact' && (
            <>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {scifact.docCount} docs
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {scifact.queryCount} queries
              </Badge>
            </>
          )}
          {ds.license && (
            <Badge variant="outline" className="text-[10px]">
              {ds.license}
            </Badge>
          )}
        </div>
      </CardContent>

      {progress && progress.phase !== 'complete' && <ProgressBar progress={progress} />}

      <CardFooter className="relative">
        {busy && (
          <div className="flex w-full gap-2">
            <Button type="button" variant="outline" className="flex-1" disabled>
              <Loader2 className="size-3.5 animate-spin" />
              {loading ? 'Loading...' : 'Restoring...'}
            </Button>
            {loading && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                onClick={handleCancelClick}
              >
                <X className="size-3.5" />
                <span className="sr-only">Cancel load</span>
              </Button>
            )}
          </div>
        )}
        {!busy && engineFailed && (
          <Button type="button" variant="outline" className="w-full" disabled>
            <TriangleAlert className="size-3.5" />
            Server unavailable
          </Button>
        )}
        {!busy && !engineFailed && !loaded && (
          <Button type="button" className="w-full" onClick={handleConfigureClick}>
            <Settings2 className="size-3.5" />
            Configure
          </Button>
        )}
        {!busy && !engineFailed && loaded && (
          <div className="flex w-full items-center gap-2">
            <Button type="button" className="flex-1" onClick={handleViewClick}>
              <FileText className="size-3.5" />
              View documents
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="icon" onClick={handleConfigureClick}>
                  <Settings2 className="size-3.5" />
                  <span className="sr-only">Reconfigure {ds.title}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reconfigure</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={handleRemoveClick}
                >
                  <Trash2 className="size-3.5" />
                  <span className="sr-only">Remove {ds.title}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove index</TooltipContent>
            </Tooltip>
          </div>
        )}
      </CardFooter>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{ds.title}</SheetTitle>
            <SheetDescription>{ds.sheetDescription}</SheetDescription>
          </SheetHeader>
          <div className="px-4">{configContent}</div>
          <SheetFooter>
            <Button type="button" className="w-full" disabled={loadDisabled} onClick={handleLoadClick}>
              {loaded ? 'Reload dataset' : 'Load dataset'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </Card>
  )
}
