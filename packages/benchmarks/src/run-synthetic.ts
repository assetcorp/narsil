import os from 'node:os'
import type { EngineId } from './runner/jobs'
import { ProgressStore } from './runner/progress'
import { prepareRunArtifact } from './runner/run-paths'
import { runMutationTier, runQualityTier, runSerializationTier } from './runner/tiers-extra'
import { runTextTier } from './runner/tiers-text'
import { runVectorTier } from './runner/tiers-vector'
import { getPackageVersion } from './stats'
import type { BenchmarkOutput } from './types'

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

const ENGINE_ORDER: EngineId[] = ['narsil', 'orama', 'minisearch']
const VECTOR_ENGINE_ORDER: EngineId[] = ['narsil', 'orama']

function buildEngineMetas(versions: Record<string, string>, names: EngineId[]) {
  return names.map(name => ({ name, version: versions[name] ?? 'unknown' }))
}

async function main() {
  const env = {
    node: process.version,
    os: os.type(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)}GB`,
  }

  console.log('Narsil Synthetic Benchmarks')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Search queries: ${SEARCH_QUERY_COUNT}`)

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }

  const { runDir, artifactPath: outputPath } = prepareRunArtifact('synthetic')
  console.log(`Run folder: ${runDir}`)
  const initial: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: SCALES,
      vectorScales: VECTOR_SCALES,
      vectorDimension: VECTOR_DIM,
      insertIterations: 5,
      warmupIterations: 2,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
      dataSource: 'synthetic',
    },
    engines: engineVersions,
    tiers: { textOnly: {}, fullSchema: {}, vector: {} },
  }
  const store = new ProgressStore({ outputPath, initial })
  store.flush()

  await runTextTier(
    {
      tierName: 'Tier 1: Text-Only Search',
      section: 'textOnly',
      adapter: 'text-only',
      engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
      scales: SCALES,
      dataSource: 'synthetic',
      seed: SEED,
      searchQueryCount: SEARCH_QUERY_COUNT,
    },
    store,
  )

  await runTextTier(
    {
      tierName: 'Tier 2: Full Schema (text + numeric + enum)',
      section: 'fullSchema',
      adapter: 'full-schema',
      engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
      scales: SCALES,
      dataSource: 'synthetic',
      seed: SEED,
      searchQueryCount: SEARCH_QUERY_COUNT,
    },
    store,
  )

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

  await runSerializationTier(
    {
      engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
      docCount: 100_000,
      dataSource: 'synthetic',
      seed: SEED,
    },
    store,
  )

  await runMutationTier(
    {
      engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
      docCount: 100_000,
      dataSource: 'synthetic',
      seed: SEED,
      searchQueryCount: SEARCH_QUERY_COUNT,
    },
    store,
  )

  await runQualityTier(
    {
      engines: buildEngineMetas(engineVersions, ENGINE_ORDER),
      docCount: 10_000,
      queryCount: 50,
      dataSource: 'synthetic',
      seed: SEED,
    },
    store,
  )

  store.flush()
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
