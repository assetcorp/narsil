import type { DatasetLoadProgress } from '../types'
import { Progress } from './ui/progress'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getLabel(progress: DatasetLoadProgress): string {
  switch (progress.phase) {
    case 'fetching': {
      if (progress.totalBytes && progress.loadedBytes) {
        return `Downloading ${formatBytes(progress.loadedBytes)} of ${formatBytes(progress.totalBytes)}`
      }
      return 'Downloading...'
    }
    case 'indexing': {
      if (progress.totalDocs && progress.indexedDocs) {
        return `Indexing ${progress.indexedDocs.toLocaleString()} of ${progress.totalDocs.toLocaleString()}`
      }
      return 'Indexing...'
    }
    case 'complete':
      return 'Done'
    case 'error':
      return progress.error ?? 'Loading failed'
  }
}

function getPercent(progress: DatasetLoadProgress): number {
  switch (progress.phase) {
    case 'fetching': {
      if (progress.totalBytes && progress.loadedBytes) {
        return Math.round((progress.loadedBytes / progress.totalBytes) * 100)
      }
      return 0
    }
    case 'indexing': {
      if (progress.totalDocs && progress.indexedDocs) {
        return Math.round((progress.indexedDocs / progress.totalDocs) * 100)
      }
      return 0
    }
    case 'complete':
      return 100
    case 'error':
      return 0
  }
}

export function LoadProgress({ progress }: { progress: DatasetLoadProgress }) {
  const percent = getPercent(progress)
  const label = getLabel(progress)
  const isError = progress.phase === 'error'

  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={percent} className={isError ? '[&_[data-slot=progress-indicator]]:bg-destructive' : ''} />
      <p className={`text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>{label}</p>
    </div>
  )
}
