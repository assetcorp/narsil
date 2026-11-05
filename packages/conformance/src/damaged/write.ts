import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { jsonText, SAMPLES_ROOT } from '../samples/catalog'
import { archiveCases } from './archive-cases'
import type { CaseBuild } from './build'
import { checkpointPath, fittedManifest } from './bytes'
import { CASES_PATH, DAMAGED_ROOT, type DamagedCase } from './case'
import { envelopeCases } from './envelope-cases'
import { exportCases } from './export-cases'
import { keywordSegmentCases } from './keyword-cases'
import { logCases } from './log-cases'
import { manifestAndMetadataCases } from './manifest-cases'
import { type CaseOutcome, openCase } from './open'
import { pagedSegmentCases } from './paged-cases'
import { vectorCases } from './vector-cases'

const DAMAGED = 'damaged'

async function placed(relative: string, bytes: Uint8Array | string): Promise<string> {
  await mkdir(dirname(join(SAMPLES_ROOT, relative)), { recursive: true })
  await writeFile(join(SAMPLES_ROOT, relative), bytes)
  return relative
}

async function expectedDocumentsOf(indexName: string, written: Map<string, string>): Promise<string> {
  const known = written.get(indexName)
  if (known !== undefined) return known
  const outcome = await openCase({
    name: indexName,
    rule: 'base',
    open: 'checkpoint',
    index: indexName,
    base: checkpointPath(indexName),
    files: {},
    expect: { documents: '' },
  })
  if (!('documents' in outcome))
    throw new Error(`the ${indexName} checkpoint fails to open: ${JSON.stringify(outcome)}`)
  const path = await placed(`${DAMAGED}/expected/${indexName}.json`, jsonText(outcome.documents))
  written.set(indexName, path)
  return path
}

async function caseOf(build: CaseBuild, expected: Map<string, string>): Promise<DamagedCase> {
  const directory = `${DAMAGED}/${build.name}`
  if (build.open === 'checkpoint') {
    if (build.fitManifest && [...build.files.keys()].some(key => key !== 'manifest')) {
      build.files.set('manifest', await fittedManifest(build.index, build.files))
    }
    const files: Record<string, string> = {}
    for (const [relative, bytes] of build.files) files[relative] = await placed(`${directory}/${relative}`, bytes)
    return {
      name: build.name,
      rule: build.rule,
      open: 'checkpoint',
      index: build.index,
      base: checkpointPath(build.index),
      files,
      ...(build.remove === undefined ? {} : { remove: build.remove }),
      ...(build.search === undefined ? {} : { search: build.search }),
      expect:
        build.code === null ? { documents: await expectedDocumentsOf(build.index, expected) } : { code: build.code },
    }
  }
  const extension = build.open === 'archive' ? 'tar' : build.gzip ? 'jsonl.gz' : 'jsonl'
  const file = await placed(`${directory}/${build.open}.${extension}`, build.gzip ? gzipSync(build.bytes) : build.bytes)
  const shared = { name: build.name, rule: build.rule, index: build.index, file }
  if (build.open === 'archive') {
    if (build.code === null) throw new Error(`${build.name} gives no code`)
    return { ...shared, open: 'archive', expect: { code: build.code } }
  }
  const expect =
    build.code === null
      ? { documents: await expectedDocumentsOf(build.index, expected) }
      : build.line === undefined
        ? { code: build.code }
        : { code: build.code, ...build.line }
  return { ...shared, open: 'export', ...(build.gzip ? { gzip: true } : {}), expect }
}

export function outcomeProblem(entry: DamagedCase, outcome: CaseOutcome, documents: unknown): string | null {
  const expect = entry.expect
  if ('documents' in expect) {
    if (!('documents' in outcome)) return `refused with ${JSON.stringify(outcome)}`
    return JSON.stringify(outcome.documents) === JSON.stringify(documents) ? null : 'opened with other documents'
  }
  if ('line' in expect) {
    if (!('refusedLines' in outcome)) return `gave ${JSON.stringify(outcome)}`
    const [only] = outcome.refusedLines
    if (outcome.refusedLines.length !== 1 || only?.line !== expect.line || only.code !== expect.code)
      return `refused ${JSON.stringify(outcome.refusedLines)}`
    return outcome.imported === expect.imported ? null : `imported ${outcome.imported}`
  }
  return 'refused' in outcome && outcome.refused === expect.code
    ? null
    : `gave ${JSON.stringify(outcome).slice(0, 300)}`
}

async function main(): Promise<void> {
  await rm(DAMAGED_ROOT, { recursive: true, force: true })
  const builds: CaseBuild[] = [
    ...(await envelopeCases()),
    ...(await keywordSegmentCases()),
    ...(await pagedSegmentCases()),
    ...(await vectorCases()),
    ...(await logCases()),
    ...(await manifestAndMetadataCases()),
    ...(await archiveCases()),
    ...(await exportCases()),
  ]
  const expected = new Map<string, string>()
  const cases: DamagedCase[] = []
  const problems: string[] = []
  for (const build of builds) {
    const entry = await caseOf(build, expected)
    cases.push(entry)
    try {
      const outcome = await openCase(entry)
      const documents =
        'documents' in entry.expect
          ? JSON.parse(await readFile(join(SAMPLES_ROOT, entry.expect.documents), 'utf8'))
          : null
      const problem = outcomeProblem(entry, outcome, documents)
      if (problem !== null) problems.push(`${entry.name}: ${problem}`)
    } catch (error) {
      problems.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await writeFile(CASES_PATH, `${JSON.stringify({ cases }, null, 2)}\n`)
  console.log(`wrote ${cases.length} cases under ${DAMAGED_ROOT}`)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  }
}

await main()
