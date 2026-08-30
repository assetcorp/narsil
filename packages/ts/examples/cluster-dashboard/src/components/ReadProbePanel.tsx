import { cn } from '@delali/narsil-example-shared'
import { Button } from '@delali/narsil-example-shared/ui/button'
import { Input } from '@delali/narsil-example-shared/ui/input'
import { type ChangeEvent, memo, useCallback, useState } from 'react'
import type { RunAction } from '../hooks/use-dashboard'
import { runReadProbeFn } from '../lib/actions.functions'
import type { ClusterNodeRow } from '../lib/cluster-types'
import { type DashboardControls, localReasonOf, probeWithTerm, reasonClassOf } from '../lib/controls'
import type { ReadProbeResult } from '../lib/probe-types'
import { MAX_TERM_LENGTH } from '../lib/validation'
import { NODES } from '../topology'

export type ProbeTone = 'settled' | 'narrowed' | 'refused'

const DEFAULT_TERM = 'mortgage'

interface ReadProbePanelProps {
  nodes: ClusterNodeRow[]
  controls: DashboardControls
  runAction: RunAction
}

interface NodeChoiceProps {
  node: ClusterNodeRow
  selected: boolean
  onSelect: (nodeId: string) => void
}

function NodeChoice({ node, selected, onSelect }: NodeChoiceProps) {
  const handleClick = useCallback(() => {
    onSelect(node.nodeId)
  }, [node.nodeId, onSelect])

  return (
    <Button variant={selected ? 'default' : 'outline'} size="sm" className="font-mono" onClick={handleClick}>
      {node.nodeId}
      {node.registered ? null : <span className="ml-1 text-[10px] lowercase">no etcd</span>}
    </Button>
  )
}

interface ProbeTileProps {
  title: string
  tone: ProbeTone
  headline: string
  detail: string
  footnote: string
}

const TONE_LABEL: Record<ProbeTone, string> = {
  settled: 'Complete',
  narrowed: 'Partial',
  refused: 'Refused',
}

const TONE_CLASS: Record<ProbeTone, string> = {
  settled: 'text-muted-foreground',
  narrowed: 'text-chart-3',
  refused: 'text-destructive',
}

function ProbeTile({ title, tone, headline, detail, footnote }: ProbeTileProps) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{title}</span>
        <span className={cn('text-[10px] font-medium uppercase tracking-wider', TONE_CLASS[tone])}>
          {TONE_LABEL[tone]}
        </span>
      </div>
      <p className="mt-2 font-mono text-base tabular-nums">{headline}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      <p className="mt-3 text-[11px] text-muted-foreground">{footnote}</p>
    </div>
  )
}

function searchTile(probe: ReadProbeResult): ProbeTileProps {
  const { search } = probe
  if (!search.ok) {
    return {
      title: 'search',
      tone: 'refused',
      headline: search.errorCode,
      detail: search.errorMessage,
      footnote: 'A search drops a partition it cannot reach and answers with what is left.',
    }
  }

  const { coverage } = search
  const missing = coverage.timedOutPartitions + coverage.failedPartitions

  return {
    title: 'search',
    tone: missing > 0 ? 'narrowed' : 'settled',
    headline: `${search.matchCount} matches`,
    detail: `${coverage.queriedPartitions} of ${coverage.totalPartitions} partitions answered`,
    footnote:
      missing > 0
        ? `${missing} partition${missing === 1 ? '' : 's'} went unread, so this count is lower than the corpus holds.`
        : 'Coverage reports every partition, so nothing was dropped from this answer.',
  }
}

function countTile(probe: ReadProbeResult): ProbeTileProps {
  const { count } = probe
  return {
    title: 'count',
    tone: count.ok ? 'settled' : 'refused',
    headline: count.ok ? `${count.documentCount} documents` : count.errorCode,
    detail: count.ok ? 'Every partition answered, so the figure is exact.' : count.errorMessage,
    footnote: 'An exact read refuses outright when one partition has no reachable copy.',
  }
}

function facetTile(probe: ReadProbeResult): ProbeTileProps {
  const { facets } = probe
  const title = `facets on ${probe.facetField}`
  if (!facets.ok) {
    return {
      title,
      tone: 'refused',
      headline: facets.errorCode,
      detail: facets.errorMessage,
      footnote: 'A faceted search reports the largest undercount each field can have.',
    }
  }
  const top = facets.buckets.slice(0, 3).map(bucket => `${bucket.value} ${bucket.count}`)
  return {
    title,
    tone: facets.errorBound > 0 ? 'narrowed' : 'settled',
    headline: `undercount ≤ ${facets.errorBound}`,
    detail: top.length > 0 ? top.join(', ') : 'No buckets matched',
    footnote: 'A bound of zero proves the counts exact, and anything higher is the worst case.',
  }
}

export const ReadProbePanel = memo(function ReadProbePanel({ nodes, controls, runAction }: ReadProbePanelProps) {
  const [term, setTerm] = useState(DEFAULT_TERM)
  const [probeNodeId, setProbeNodeId] = useState(NODES[0].nodeId)
  const [probe, setProbe] = useState<ReadProbeResult | null>(null)

  const control = probeWithTerm(controls.probe, term)
  const reason = localReasonOf(control, controls.blockedReason)
  const chosen = nodes.find(node => node.nodeId === probeNodeId)

  const handleTermChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTerm(event.target.value)
  }, [])

  const handleRun = useCallback(() => {
    runAction(`Reading through ${probeNodeId}`, async () => {
      setProbe(await runReadProbeFn({ data: { nodeId: probeNodeId, term: term.trim() } }))
    })
  }, [probeNodeId, runAction, term])

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-bold tracking-tight">One fault, three answers</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        This panel sends one term three ways through a single node. Cut a link and run it again to see where the three
        reads disagree.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {nodes.map(node => (
            <NodeChoice
              key={node.nodeId}
              node={node}
              selected={node.nodeId === probeNodeId}
              onSelect={setProbeNodeId}
            />
          ))}
        </div>
        <Input
          value={term}
          onChange={handleTermChange}
          maxLength={MAX_TERM_LENGTH}
          className="max-w-56"
          aria-label="Search term"
        />
        <Button onClick={handleRun} disabled={!control.enabled}>
          {controls.pendingLabel === null ? 'Run the three reads' : 'Reading'}
        </Button>
      </div>

      {reason === null ? null : <p className={cn('mt-3 text-xs', reasonClassOf(control))}>{reason}</p>}

      {chosen === undefined || chosen.registered ? null : (
        <p className="mt-3 text-xs text-muted-foreground">
          {probeNodeId} holds no registration in etcd, so the read may answer from the partitions it held before the
          cluster lost it, or that node may refuse the read outright.
        </p>
      )}

      <div className="mt-5 min-h-44">
        {probe === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Run the reads to compare how a search, a count, and a faceted search answer the same term.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <ProbeTile {...searchTile(probe)} />
            <ProbeTile {...countTile(probe)} />
            <ProbeTile {...facetTile(probe)} />
          </div>
        )}
      </div>
    </section>
  )
})
