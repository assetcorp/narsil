import { Circle, CircleCheck, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Skeleton } from '#/components/ui/skeleton'
import { cn } from '#/lib/utils'
import { ELAPSED_TICK_MS, SKELETON_CARD_COUNT } from './constants'
import type { OpeningStage } from './use-notes'

const STAGES: ReadonlyArray<{ stage: OpeningStage; label: string }> = [
  { stage: 'code', label: 'Loading the app code' },
  { stage: 'space', label: 'Finding your notes in this browser' },
  { stage: 'engine', label: "Starting the search engine and restoring this device's notes" },
  { stage: 'sync', label: 'Reading the upload queue and starting sync' },
]

const SKELETON_KEYS = Array.from({ length: SKELETON_CARD_COUNT }, (_, at) => `skeleton-${at}`)

function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / ELAPSED_TICK_MS)), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  if (seconds === 0) return null
  return <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{seconds} s</span>
}

function StageRow({ label, state }: { label: string; state: 'done' | 'current' | 'waiting' }) {
  return (
    <li className={cn('flex items-center gap-3 text-sm', state === 'waiting' && 'text-muted-foreground')}>
      {state === 'done' ? (
        <CircleCheck className="size-4 shrink-0 text-chart-2" aria-hidden="true" />
      ) : state === 'current' ? (
        <LoaderCircle
          className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <Circle className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className={cn(state === 'current' && 'font-medium')}>{label}</span>
      {state === 'current' ? <ElapsedSeconds /> : null}
    </li>
  )
}

export function OpeningProgress({ device, stage }: { device: string; stage: OpeningStage }) {
  const current = STAGES.findIndex(entry => entry.stage === stage)
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label={`Opening device ${device}`}
        aria-busy="true"
        className="rounded-lg border bg-card px-5 py-4 shadow-xs"
      >
        <p className="mb-3 text-sm font-medium">
          Opening device <span className="font-mono">{device}</span>
        </p>
        <ol className="flex flex-col gap-2.5">
          {STAGES.map((entry, at) => (
            <StageRow
              key={entry.stage}
              label={entry.label}
              state={at < current ? 'done' : at === current ? 'current' : 'waiting'}
            />
          ))}
        </ol>
      </section>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {SKELETON_KEYS.map(key => (
          <div key={key} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="mt-2 h-3 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  )
}
