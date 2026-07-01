import os from 'node:os'
import { BEIR_DATASETS, type BeirDatasetName } from './data/beir'
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './data/vectors'
import { downloadAndCacheWiki, loadWikiArticles, type WikiArticle } from './data-wiki'
import { SEARCH_REPEAT_ROUNDS, SEARCH_WARMUP_ROUNDS } from './measure'
import { printConsistencyReport } from './print'
import { runConsistencyCheck } from './runner/consistency'
import type { EngineId } from './runner/jobs'
import { ProgressStore } from './runner/progress'
import { writeReport } from './runner/report'
import { prepareRunArtifact } from './runner/run-paths'
import { runMutationTier, runRelevanceTier, runSerializationTier } from './runner/tiers-extra'
import { runTextTier } from './runner/tiers-text'
import { runVectorTier } from './runner/tiers-vector'
import { fmt, getPackageVersion } from './stats'
import type { BenchmarkOutput } from './types'

const DEFAULT_RELEVANCE_DATASET: BeirDatasetName = 'scifact'

const SCALES = [1_000, 10_000, 50_000, 100_000]
const VECTOR_DATASETS: BeirDatasetName[] = ['scifact', 'nfcorpus']
const SEED = 42
const SEARCH_QUERY_COUNT = 100
const WIKI_MAX_ARTICLES = 100_000

const ENGINE_ORDER: EngineId[] = ['narsil', 'orama', 'minisearch']
const VECTOR_ENGINE_ORDER: EngineId[] = ['narsil', 'orama']

type TierName = 'text' | 'full' | 'vector' | 'serial' | 'mutation' | 'relevance' | 'consistency'
const ALL_TIERS: TierName[] = ['text', 'full', 'vector', 'serial', 'mutation', 'relevance', 'consistency']

// Tiers that read the Wikipedia corpus; a run without any of them skips the corpus load.
const WIKI_TIERS: TierName[] = ['text', 'full', 'serial', 'mutation']

function parseTiers(args: string[]): Set<TierName> {
  const tiersIdx = args.indexOf('--tiers')
  if (tiersIdx === -1 || tiersIdx + 1 >= args.length) return new Set(ALL_TIERS)
  const names = args[tiersIdx + 1].split(',').map(s => s.trim()) as TierName[]
  const valid = new Set(ALL_TIERS)
  for (const n of names) {
    if (!valid.has(n)) {
      console.log(`Unknown tier "${n}". Valid tiers: ${ALL_TIERS.join(', ')}`)
      process.exit(1)
    }
  }
  return new Set(names)
}

function parseRelevanceDataset(args: string[]): BeirDatasetName {
  const idx = args.indexOf('--relevance-dataset')
  if (idx === -1 || idx + 1 >= args.length) return DEFAULT_RELEVANCE_DATASET
  const value = args[idx + 1]
  if ((BEIR_DATASETS as readonly string[]).includes(value)) return value as BeirDatasetName
  console.log(`Unknown relevance dataset "${value}". Valid datasets: ${BEIR_DATASETS.join(', ')}`)
  process.exit(1)
}

function buildEngineMetas(versions: Record<string, string>, names: EngineId[]) {
  return names.map(name => ({ name, version: versions[name] ?? 'unknown' }))
}

async function main() {
  const args = process.argv.slice(2)
  const refreshWiki = args.includes('--refresh-wiki')
  const noDownload = args.includes('--no-download')
  const tiers = parseTiers(args)
  const relevanceDataset = parseRelevanceDataset(args)

  const env = {
    node: process.version,
    os: os.type(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)}GB`,
  }

  console.log('Narsil Comparative Benchmarks (Wikipedia data)')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Search queries: ${SEARCH_QUERY_COUNT}`)
  console.log(`Tiers: ${Array.from(tiers).join(', ')}`)
  if (tiers.has('relevance')) console.log(`Relevance dataset: ${relevanceDataset}`)

  const needsWiki = WIKI_TIERS.some(t => tiers.has(t))
  let articles: WikiArticle[] = []
  if (needsWiki) {
    if (refreshWiki) {
      articles = await downloadAndCacheWiki(WIKI_MAX_ARTICLES)
    } else {
      articles = await loadWikiArticles(WIKI_MAX_ARTICLES, { noDownload })
    }
    console.log(`\nUsing ${fmt(articles.length)} Wikipedia articles`)
  }

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }
  const activeScales = needsWiki ? SCALES.filter(s => s <= articles.length) : SCALES
  const { runDir, artifactPath: outputPath } = prepareRunArtifact('comparative')
  console.log(`Run folder: ${runDir}`)

  const initial: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: activeScales,
      vectorModel: EMBEDDING_MODEL,
      vectorDimension: EMBEDDING_DIM,
      vectorDatasets: VECTOR_DATASETS,
      insertIterations: 5,
      warmupIterations: 2,
      searchWarmupRounds: SEARCH_WARMUP_ROUNDS,
      searchRepeatRounds: SEARCH_REPEAT_ROUNDS,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
      dataSource: 'wiki',
      wikiArticleCount: needsWiki ? articles.length : undefined,
    },
    engines: engineVersions,
    tiers: { textOnly: {}, fullSchema: {} },
  }
  const store = new ProgressStore({ outputPath, initial })
  store.flush()

  if (tiers.has('text')) {
    await runTextTier(
      {
        tierName: 'Tier 1: Text-Only Search (Wikipedia)',
        section: 'textOnly',
        adapter: 'text-only',
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        scales: activeScales,
        dataSource: 'wiki',
        seed: SEED,
        searchQueryCount: SEARCH_QUERY_COUNT,
      },
      store,
    )
  }

  if (tiers.has('full')) {
    await runTextTier(
      {
        tierName: 'Tier 2: Full Schema (Wikipedia + derived score/category)',
        section: 'fullSchema',
        adapter: 'full-schema',
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        scales: activeScales,
        dataSource: 'wiki',
        seed: SEED,
        searchQueryCount: SEARCH_QUERY_COUNT,
      },
      store,
    )
  }

  if (tiers.has('vector')) {
    await runVectorTier(
      {
        engines: buildEngineMetas(engineVersions, VECTOR_ENGINE_ORDER),
        datasets: VECTOR_DATASETS,
      },
      store,
    )
  }

  if (tiers.has('serial')) {
    const maxDocs = Math.min(100_000, articles.length)
    await runSerializationTier(
      {
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        docCount: maxDocs,
        dataSource: 'wiki',
        seed: SEED,
      },
      store,
    )
  }

  if (tiers.has('mutation')) {
    const maxDocs = Math.min(100_000, articles.length)
    await runMutationTier(
      {
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        docCount: maxDocs,
        dataSource: 'wiki',
        seed: SEED,
        searchQueryCount: SEARCH_QUERY_COUNT,
      },
      store,
    )
  }

  if (tiers.has('relevance')) {
    await runRelevanceTier(
      {
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        dataset: relevanceDataset,
      },
      store,
    )
  }

  if (tiers.has('consistency')) {
    const report = await runConsistencyCheck(relevanceDataset, ENGINE_ORDER, store)
    if (report) printConsistencyReport(report)
  }

  store.flush()
  const reportPath = writeReport(store.snapshot(), runDir)
  console.log(`\nResults saved to ${outputPath}`)
  console.log(`Report written to ${reportPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
