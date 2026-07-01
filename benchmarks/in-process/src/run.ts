import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAndCacheWiki, loadWikiArticles, type WikiArticle } from './data-wiki'
import type { EngineId } from './runner/jobs'
import { ProgressStore } from './runner/progress'
import { prepareRunArtifact } from './runner/run-paths'
import { runCranfieldTier, runMutationTier, runSerializationTier } from './runner/tiers-extra'
import { runTextTier } from './runner/tiers-text'
import { runVectorTier } from './runner/tiers-vector'
import { fmt, getPackageVersion } from './stats'
import type { BenchmarkOutput } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCALES = [1_000, 10_000, 50_000, 100_000]
const VECTOR_SCALES_BY_DIM: Record<number, number[]> = {
  1536: [10_000, 50_000, 100_000],
  3072: [10_000, 50_000],
}
const VECTOR_DIMS = [1536, 3072]
const VECTOR_SCALES = [10_000, 50_000, 100_000]
const VECTOR_DIM = 1536
const SEED = 42
const SEARCH_QUERY_COUNT = 100
const WIKI_MAX_ARTICLES = 100_000

const ENGINE_ORDER: EngineId[] = ['narsil', 'orama', 'minisearch']
const VECTOR_ENGINE_ORDER: EngineId[] = ['narsil', 'orama']

type TierName = 'text' | 'full' | 'vector' | 'serial' | 'mutation' | 'cranfield'
const ALL_TIERS: TierName[] = ['text', 'full', 'vector', 'serial', 'mutation', 'cranfield']

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

function buildEngineMetas(versions: Record<string, string>, names: EngineId[]) {
  return names.map(name => ({ name, version: versions[name] ?? 'unknown' }))
}

async function main() {
  const args = process.argv.slice(2)
  const refreshWiki = args.includes('--refresh-wiki')
  const noDownload = args.includes('--no-download')
  const tiers = parseTiers(args)

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

  let articles: WikiArticle[]
  if (refreshWiki) {
    articles = await downloadAndCacheWiki(WIKI_MAX_ARTICLES)
  } else {
    articles = await loadWikiArticles(WIKI_MAX_ARTICLES, { noDownload })
  }
  console.log(`\nUsing ${fmt(articles.length)} Wikipedia articles`)

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }
  const activeScales = SCALES.filter(s => s <= articles.length)
  const { runDir, artifactPath: outputPath } = prepareRunArtifact('comparative')
  console.log(`Run folder: ${runDir}`)

  const initial: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: activeScales,
      vectorScales: VECTOR_SCALES,
      vectorDimension: VECTOR_DIM,
      insertIterations: 5,
      warmupIterations: 2,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
      dataSource: 'wiki',
      wikiArticleCount: articles.length,
    },
    engines: engineVersions,
    tiers: { textOnly: {}, fullSchema: {}, vector: {} },
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
    for (const dim of VECTOR_DIMS) {
      const scales = VECTOR_SCALES_BY_DIM[dim] ?? [10_000, 50_000]
      await runVectorTier(
        {
          engines: buildEngineMetas(engineVersions, VECTOR_ENGINE_ORDER),
          scales,
          dimension: dim,
          seed: SEED,
          searchQueryCount: SEARCH_QUERY_COUNT,
        },
        store,
      )
    }
    store.promoteVectorPrimary(VECTOR_DIMS[0])
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

  if (tiers.has('cranfield')) {
    const fixturesDir = resolve(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'ts',
      'src',
      '__tests__',
      'relevance',
      'fixtures',
    )
    await runCranfieldTier(
      {
        engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
        fixturesDir,
      },
      store,
    )
  }

  store.flush()
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
