import { resolve } from 'node:path'
import { fmt } from '../stats'
import type {
  BenchmarkOutput,
  ConsistencyReport,
  MutationResult,
  RelevanceQualityResult,
  ScaleResult,
  VectorRelevanceResult,
} from '../types'
import { writeTextAtomicSync } from './atomic-write'
import {
  describeSerializationLimit,
  type SerializationResultWithError,
  STRING_SERIALIZATION_LIMIT_CELL,
} from './error-records'

const ENGINE_ORDER = ['narsil', 'orama', 'minisearch']

interface EngineMeta {
  name: string
  version: string
}

type Align = 'left' | 'right'

function engineMetas(engines: Record<string, string>): EngineMeta[] {
  const present = Object.keys(engines)
  const ordered = ENGINE_ORDER.filter(name => present.includes(name))
  for (const name of present) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  return ordered.map(name => ({ name, version: engines[name] ?? 'unknown' }))
}

function mdTable(headers: string[], aligns: Align[], rows: string[][]): string[] {
  const separator = aligns.map(a => (a === 'right' ? '---:' : '---'))
  const lines = [`| ${headers.join(' | ')} |`, `| ${separator.join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines
}

function headerSection(output: BenchmarkOutput): string[] {
  const { env, config } = output
  const metas = engineMetas(output.engines)
  const lines: string[] = ['# Narsil in-process benchmark: Narsil vs Orama vs MiniSearch', '']
  lines.push(`Generated ${output.timestamp}`, '')

  lines.push('## Environment', '')
  lines.push(
    ...mdTable(
      ['Field', 'Value'],
      ['left', 'left'],
      [
        ['Node', env.node],
        ['OS / arch', `${env.os} ${env.arch}`],
        ['CPU', env.cpu],
        ['Total memory', env.totalMemory],
      ],
    ),
    '',
  )

  lines.push('## Engines', '')
  lines.push(
    ...mdTable(
      ['Engine', 'Version'],
      ['left', 'left'],
      metas.map(m => [m.name, m.version]),
    ),
    '',
  )

  const dataSource = config.wikiArticleCount
    ? `${config.dataSource} (${fmt(config.wikiArticleCount)} articles)`
    : config.dataSource
  lines.push('## Methodology', '')
  lines.push(
    ...mdTable(
      ['Setting', 'Value'],
      ['left', 'left'],
      [
        ['Data source', dataSource],
        ['Scales', config.scales.map(s => fmt(s)).join(', ')],
        ['Seed', String(config.seed)],
        ['Insert iterations', String(config.insertIterations)],
        ['Search warmup / repeat rounds', `${config.searchWarmupRounds} / ${config.searchRepeatRounds}`],
        ['Search queries', String(config.searchQueryCount)],
        ['Vector model', `${config.vectorModel} (${config.vectorDimension}d)`],
      ],
    ),
    '',
  )

  const dataset = output.relevanceDataset
  if (dataset) {
    lines.push('## Relevance dataset identity', '')
    lines.push(
      ...mdTable(
        ['Field', 'Value'],
        ['left', 'left'],
        [
          ['Dataset', dataset.name],
          ['Documents', fmt(dataset.documents)],
          ['Queries', fmt(dataset.queries)],
          ['Archive SHA-256', dataset.archiveSha256],
          ['Corpus fingerprint', dataset.corpusFingerprint],
        ],
      ),
      '',
    )
  }

  return lines
}

function scaleRows(
  metas: EngineMeta[],
  scales: number[],
  results: Record<string, Record<number, ScaleResult>>,
  cell: (r: ScaleResult) => string,
): string[][] {
  const rows: string[][] = []
  for (const { name, version } of metas) {
    const perScale = results[name]
    if (!perScale) continue
    rows.push([`${name} v${version}`, ...scales.map(s => (perScale[s] ? cell(perScale[s]) : 'n/a'))])
  }
  return rows
}

function scaleTierSection(
  title: string,
  results: Record<string, Record<number, ScaleResult>>,
  metas: EngineMeta[],
  scales: number[],
): string[] {
  if (Object.keys(results).length === 0) return []
  const headers = ['Engine', ...scales.map(s => `${fmt(s)} docs`)]
  const aligns: Align[] = ['left', ...scales.map((): Align => 'right')]

  const lines: string[] = [`## ${title}`, '']
  lines.push('### Insert throughput (docs/sec)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      scaleRows(metas, scales, results, r => (r.insertDocsPerSec > 0 ? fmt(r.insertDocsPerSec) : 'n/a')),
    ),
    '',
  )
  lines.push('### Search latency p50 ms (p95)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      scaleRows(metas, scales, results, r =>
        r.searchMedianMs >= 0 ? `${r.searchMedianMs.toFixed(3)} (${r.searchP95Ms.toFixed(3)})` : 'n/a',
      ),
    ),
    '',
  )
  lines.push('### Memory (MB)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      scaleRows(metas, scales, results, r => (r.memoryMb >= 0 ? r.memoryMb.toFixed(1) : 'n/a')),
    ),
    '',
  )

  const anyFiltered = metas.some(({ name }) =>
    scales.some(s => results[name]?.[s]?.filteredSearchMedianMs !== undefined),
  )
  if (anyFiltered) {
    lines.push('### Filtered search latency p50 ms (p95)', '')
    const rows: string[][] = []
    for (const { name, version } of metas) {
      const perScale = results[name]
      if (!perScale) continue
      const supportsFilter = scales.some(s => perScale[s]?.filteredSearchMedianMs !== undefined)
      if (!supportsFilter) {
        rows.push([`${name} v${version}`, ...scales.map(() => 'not supported')])
        continue
      }
      rows.push([
        `${name} v${version}`,
        ...scales.map(s => {
          const r = perScale[s]
          if (!r || r.filteredSearchMedianMs === undefined) return 'n/a'
          return `${r.filteredSearchMedianMs.toFixed(3)} (${r.filteredSearchP95Ms?.toFixed(3) ?? 'n/a'})`
        }),
      ])
    }
    lines.push(...mdTable(headers, aligns, rows), '')
  }

  return lines
}

function vectorSection(
  results: Record<string, Record<string, VectorRelevanceResult>>,
  metas: EngineMeta[],
  datasets: string[],
): string[] {
  const present = metas.filter(m => results[m.name] && Object.keys(results[m.name]).length > 0)
  if (present.length === 0) return []
  const headers = ['Engine', ...datasets]
  const aligns: Align[] = ['left', ...datasets.map((): Align => 'right')]

  const rowsFor = (render: (r: VectorRelevanceResult) => string): string[][] =>
    present.map(m => [
      `${m.name} v${m.version}`,
      ...datasets.map(d => {
        const r = results[m.name]?.[d]
        return !r || r.meanRecallAt10 < 0 ? 'n/a' : render(r)
      }),
    ])

  const lines: string[] = ['## Vector search (Narsil vs Orama)', '']
  lines.push('### Recall@10 vs exact KNN', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      rowsFor(r => `${(r.meanRecallAt10 * 100).toFixed(1)}%`),
    ),
    '',
  )
  lines.push('### Insert throughput (docs/sec)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      rowsFor(r => fmt(r.insertDocsPerSec)),
    ),
    '',
  )
  lines.push('### Search latency p50 ms (p95 / p99)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      rowsFor(
        r =>
          `${r.searchLatency.p50Ms.toFixed(3)} (${r.searchLatency.p95Ms.toFixed(3)} / ${r.searchLatency.p99Ms.toFixed(3)})`,
      ),
    ),
    '',
  )
  lines.push('### Memory (MB)', '')
  lines.push(
    ...mdTable(
      headers,
      aligns,
      rowsFor(r => r.memoryMb.toFixed(1)),
    ),
    '',
  )
  return lines
}

function serializationSection(results: Record<string, SerializationResultWithError>, metas: EngineMeta[]): string[] {
  if (Object.keys(results).length === 0) return []
  const rows: string[][] = []
  for (const { name, version } of metas) {
    const r = results[name]
    if (!r) continue
    const label = `${name} v${version}`
    if (describeSerializationLimit(r.error)) {
      rows.push([label, STRING_SERIALIZATION_LIMIT_CELL, '', ''])
      continue
    }
    if (r.error) {
      rows.push([label, `error (${r.error.code})`, '', ''])
      continue
    }
    rows.push([
      label,
      r.serializeMs.toFixed(1),
      (r.serializedBytes / 1024 / 1024).toFixed(1),
      r.deserializeAndSearchMs.toFixed(1),
    ])
  }
  const lines: string[] = ['## Serialization (each engine on its shipped format)', '']
  lines.push(
    ...mdTable(
      ['Engine', 'Serialize (ms)', 'Size (MB)', 'Deserialize+Search (ms)'],
      ['left', 'right', 'right', 'right'],
      rows,
    ),
    '',
  )
  return lines
}

function mutationSection(results: Record<string, MutationResult>, metas: EngineMeta[]): string[] {
  if (Object.keys(results).length === 0) return []
  const rows: string[][] = []
  for (const { name, version } of metas) {
    const r = results[name]
    if (!r) continue
    rows.push([
      `${name} v${version}`,
      r.removeDocsPerSec > 0 ? fmt(r.removeDocsPerSec) : 'n/a',
      r.searchAfterRemoveMedianMs >= 0 ? r.searchAfterRemoveMedianMs.toFixed(3) : 'n/a',
      r.reinsertDocsPerSec > 0 ? fmt(r.reinsertDocsPerSec) : 'n/a',
    ])
  }
  const lines: string[] = ['## Mutation', '']
  lines.push(
    ...mdTable(
      ['Engine', 'Remove (docs/sec)', 'Search after remove (ms)', 'Reinsert (docs/sec)'],
      ['left', 'right', 'right', 'right'],
      rows,
    ),
    '',
  )
  return lines
}

function relevanceSection(results: Record<string, RelevanceQualityResult>, metas: EngineMeta[]): string[] {
  if (Object.keys(results).length === 0) return []
  const sample = Object.values(results)[0]
  const title = sample
    ? `## Relevance quality (BEIR ${sample.dataset}, ${fmt(sample.docCount)} docs, human judgments)`
    : '## Relevance quality (BEIR, human judgments)'
  const rows: string[][] = []
  for (const { name, version } of metas) {
    const r = results[name]
    if (!r) continue
    rows.push([
      `${name} v${version}`,
      r.meanNdcg10.toFixed(4),
      r.meanPrecision10.toFixed(4),
      r.meanMap.toFixed(4),
      r.meanMrr.toFixed(4),
      String(r.queryCount),
    ])
  }
  const lines: string[] = [title, '']
  lines.push(
    ...mdTable(
      ['Engine', 'nDCG@10', 'P@10', 'MAP', 'MRR', 'Queries'],
      ['left', 'right', 'right', 'right', 'right', 'right'],
      rows,
    ),
    '',
  )
  return lines
}

function consistencySection(report: ConsistencyReport): string[] {
  const lines: string[] = ['## Cross-engine consistency', '']
  lines.push(`Corpus: BEIR ${report.dataset}, ${fmt(report.queryCount)} judged queries.`, '')
  lines.push(
    ...mdTable(
      ['Engine', 'Mean hits/query'],
      ['left', 'right'],
      report.engines.map(engine => [engine, report.meanHitsByEngine[engine]?.toFixed(1) ?? 'n/a']),
    ),
    '',
  )
  lines.push(`Mean pairwise top-10 overlap (Jaccard): ${report.meanPairwiseTop10Jaccard.toFixed(3)}`, '')
  if (report.zeroDivergenceCount === 0) {
    lines.push('No zero-hit divergences: every engine returned matches for every query another engine matched.', '')
  } else {
    lines.push(
      `${report.zeroDivergenceCount} of ${fmt(report.queryCount)} queries had one engine return 0 hits while another matched.`,
      '',
    )
  }
  return lines
}

export function renderReport(output: BenchmarkOutput): string {
  const metas = engineMetas(output.engines)
  const scales = output.config.scales
  const lines: string[] = [...headerSection(output)]

  lines.push(...scaleTierSection('Text-only search', output.tiers.textOnly, metas, scales))
  lines.push(...scaleTierSection('Full schema (text + numeric + enum)', output.tiers.fullSchema, metas, scales))
  if (output.vectorRelevance) lines.push(...vectorSection(output.vectorRelevance, metas, output.config.vectorDatasets))
  if (output.serialization) lines.push(...serializationSection(output.serialization, metas))
  if (output.mutations) lines.push(...mutationSection(output.mutations, metas))
  if (output.relevanceQuality) lines.push(...relevanceSection(output.relevanceQuality, metas))
  if (output.consistency) lines.push(...consistencySection(output.consistency))

  return `${lines.join('\n').trimEnd()}\n`
}

export function writeReport(output: BenchmarkOutput, runDir: string): string {
  const reportPath = resolve(runDir, 'comparison.md')
  writeTextAtomicSync(reportPath, renderReport(output))
  return reportPath
}
