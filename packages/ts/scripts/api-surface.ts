import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Extractor, ExtractorConfig, type ExtractorMessage } from '@microsoft/api-extractor'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(scriptDirectory, '..')
const REPORT_DIR = join(PACKAGE_DIR, 'etc')
const WORK_DIR = join(PACKAGE_DIR, '.cache', 'api-extractor')
const CONFIG_DIR = join(WORK_DIR, 'config')
const GENERATED_DIR = join(WORK_DIR, 'reports')
const TEMP_DIR = join(WORK_DIR, 'temp')
const REPORT_SUFFIX = '.api.md'
const DOC_MODEL_SUFFIX = '.api.json'
const WRITE_HINT = 'Run "pnpm nx run narsil-ts:api:write" to regenerate every API report.'
const DEPRECATION_RULE =
  '@deprecated must name the replacement with {@link ...} and the release that drops it, written as "removed in v1.2.0"'
const RELEASE_TAG_RULE = '@delali/narsil publishes @public and @internal only'

interface EntryPoint {
  subpath: string
  reportName: string
  typesPath: string
}

interface Manifest {
  name: string
  exports: Record<string, unknown>
}

function manifest(): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json is not an object')
  }
  const { name, exports } = parsed as Record<string, unknown>
  if (typeof name !== 'string') {
    throw new Error('package.json declares no name')
  }
  if (typeof exports !== 'object' || exports === null) {
    throw new Error('package.json declares no exports map, so no entry point can be analysed')
  }
  return { name, exports: exports as Record<string, unknown> }
}

function typesTarget(condition: unknown): string | null {
  if (typeof condition !== 'object' || condition === null) return null
  const record = condition as Record<string, unknown>
  if (typeof record.types === 'string') return record.types
  for (const nested of Object.values(record)) {
    const found = typesTarget(nested)
    if (found !== null) return found
  }
  return null
}

function reportName(packageName: string, subpath: string): string {
  if (subpath === '.') return packageName.replace(/^@[^/]+\//, '')
  return subpath.replace(/^\.\//, '').replace(/\//g, '-')
}

function expandWildcard(packageName: string, subpath: string, types: string): EntryPoint[] {
  const star = types.indexOf('*')
  const prefix = types.slice(0, star)
  const suffix = types.slice(star + 1)
  const cut = prefix.lastIndexOf('/') + 1
  const directory = join(PACKAGE_DIR, prefix.slice(0, cut))
  const leading = prefix.slice(cut)
  const found: EntryPoint[] = []
  if (!existsSync(directory)) return found
  for (const file of readdirSync(directory).sort()) {
    if (!file.startsWith(leading) || !file.endsWith(suffix)) continue
    const captured = file.slice(leading.length, file.length - suffix.length)
    if (captured.length === 0) continue
    const resolvedSubpath = subpath.replace('*', captured)
    found.push({
      subpath: resolvedSubpath,
      reportName: reportName(packageName, resolvedSubpath),
      typesPath: join(PACKAGE_DIR, types.replace('*', captured)),
    })
  }
  return found
}

function entryPoints(): EntryPoint[] {
  const { name, exports } = manifest()
  const found: EntryPoint[] = []
  for (const [subpath, condition] of Object.entries(exports)) {
    const types = typesTarget(condition)
    if (types === null) {
      throw new Error(`the "${subpath}" export declares no types condition, so its API cannot be analysed`)
    }
    if (types.includes('*')) {
      found.push(...expandWildcard(name, subpath, types))
      continue
    }
    found.push({ subpath, reportName: reportName(name, subpath), typesPath: join(PACKAGE_DIR, types) })
  }
  return found.sort((left, right) => left.reportName.localeCompare(right.reportName))
}

function writeConfig(entry: EntryPoint): string {
  const path = join(CONFIG_DIR, `${entry.reportName}.json`)
  const config = {
    projectFolder: PACKAGE_DIR,
    mainEntryPointFilePath: entry.typesPath,
    newlineKind: 'lf',
    apiReport: {
      enabled: true,
      reportFolder: GENERATED_DIR,
      reportTempFolder: TEMP_DIR,
      reportFileName: `${entry.reportName}${REPORT_SUFFIX}`,
    },
    docModel: {
      enabled: true,
      apiJsonFilePath: join(TEMP_DIR, `${entry.reportName}${DOC_MODEL_SUFFIX}`),
    },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM'],
          strict: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['dist/**/*.d.ts'],
      },
    },
    messages: {
      compilerMessageReporting: { default: { logLevel: 'error' } },
      extractorMessageReporting: {
        default: { logLevel: 'error' },
        'ae-undocumented': { logLevel: 'error', addToApiReportFile: false },
        'ae-forgotten-export': { logLevel: 'error', addToApiReportFile: false },
        'ae-internal-missing-underscore': { logLevel: 'none' },
      },
      tsdocMessageReporting: { default: { logLevel: 'error' } },
    },
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}

const QUOTED_ITEM = /"([^"]+)"/g

function itemName(message: ExtractorMessage): string {
  const quoted = [...message.text.matchAll(QUOTED_ITEM)]
  return quoted.length === 0 ? message.text : quoted[quoted.length - 1][1]
}

interface Analysis {
  undocumented: string[]
  unreachable: string[]
  unlinked: string[]
  problems: string[]
}

function analyse(entry: EntryPoint): Analysis {
  const undocumented: string[] = []
  const unreachable: string[] = []
  const unlinked: string[] = []
  const problems: string[] = []
  const config = ExtractorConfig.loadFileAndPrepare(writeConfig(entry))
  Extractor.invoke(config, {
    localBuild: true,
    showVerboseMessages: false,
    messageCallback(message: ExtractorMessage): void {
      message.handled = true
      if (message.category === 'console') return
      if (message.messageId === 'ae-undocumented') {
        undocumented.push(itemName(message))
        return
      }
      if (message.messageId === 'ae-forgotten-export') {
        unreachable.push(itemName(message))
        return
      }
      if (message.messageId === 'ae-unresolved-link') {
        unlinked.push(itemName(message))
        return
      }
      problems.push(`${entry.subpath}: ${message.text}`)
    },
  })
  return { undocumented, unreachable, unlinked, problems }
}

interface DocModelItem {
  name?: string
  docComment?: string
  members?: DocModelItem[]
}

const DEPRECATED_BLOCK = /@deprecated([\s\S]*?)(?=\n\s*\*\s*@|\*\/$)/
const REPLACEMENT_REFERENCE = /\{@link\s+[^}]+\}/
const REMOVAL_RELEASE = /removed in v\d+\.\d+\.\d+/
const FORBIDDEN_RELEASE_TAG = /@(alpha|beta)\b/

function inspectDocComments(entry: EntryPoint, exported: Set<string>, problems: string[]): void {
  const path = join(TEMP_DIR, `${entry.reportName}${DOC_MODEL_SUFFIX}`)
  if (!existsSync(path)) return
  const model: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  for (const entryPointItem of (model as DocModelItem).members ?? []) {
    for (const item of entryPointItem.members ?? []) {
      if (item.name !== undefined) exported.add(item.name)
    }
  }
  const pending: Array<{ item: DocModelItem; path: string }> = [{ item: model as DocModelItem, path: '' }]
  while (pending.length > 0) {
    const next = pending.shift()
    if (next === undefined) continue
    const { item } = next
    const name = next.path === '' ? (item.name ?? '') : next.path
    const comment = item.docComment ?? ''
    const forbidden = FORBIDDEN_RELEASE_TAG.exec(comment)
    if (forbidden !== null) {
      problems.push(`${entry.subpath}: ${name} carries ${forbidden[0]}, and ${RELEASE_TAG_RULE}`)
    }
    const deprecated = DEPRECATED_BLOCK.exec(comment)
    if (deprecated !== null) {
      const text = deprecated[1]
      if (!REPLACEMENT_REFERENCE.test(text) || !REMOVAL_RELEASE.test(text)) {
        problems.push(`${entry.subpath}: ${name} is deprecated, and ${DEPRECATION_RULE}`)
      }
    }
    for (const member of item.members ?? []) {
      pending.push({ item: member, path: next.path === '' ? (member.name ?? '') : `${next.path}.${member.name ?? ''}` })
    }
  }
}

function trackedReports(): string[] {
  if (!existsSync(REPORT_DIR)) return []
  return readdirSync(REPORT_DIR)
    .filter(file => file.endsWith(REPORT_SUFFIX))
    .sort()
}

function reconcileReports(entries: EntryPoint[], write: boolean): string[] {
  const problems: string[] = []
  const expected = new Set(entries.map(entry => `${entry.reportName}${REPORT_SUFFIX}`))

  for (const entry of entries) {
    const file = `${entry.reportName}${REPORT_SUFFIX}`
    const generated = readFileSync(join(GENERATED_DIR, file), 'utf-8')
    const trackedPath = join(REPORT_DIR, file)
    if (write) {
      writeFileSync(trackedPath, generated)
      continue
    }
    if (!existsSync(trackedPath)) {
      problems.push(`the "${entry.subpath}" export has no API report; create etc/${file}`)
      continue
    }
    if (readFileSync(trackedPath, 'utf-8') !== generated) {
      problems.push(`etc/${file} no longer matches the "${entry.subpath}" export`)
    }
  }

  for (const file of trackedReports()) {
    if (expected.has(file)) continue
    if (write) {
      rmSync(join(REPORT_DIR, file))
      continue
    }
    problems.push(`etc/${file} covers no export in package.json, so delete it or restore the export it reported`)
  }

  return problems
}

function undocumentedSummary(entries: Map<string, string[]>): string[] {
  const lines: string[] = []
  let total = 0
  for (const [subpath, names] of entries) {
    total += names.length
    lines.push(`${subpath}: ${names.length} without a summary`)
    for (const name of names.slice(0, 10)) lines.push(`  ${name}`)
    if (names.length > 10) lines.push(`  ...and ${names.length - 10} more`)
  }
  if (total > 0) {
    lines.unshift(`${total} published declarations carry no TSDoc summary:`)
  }
  return lines
}

function run(write: boolean): number {
  for (const directory of [CONFIG_DIR, GENERATED_DIR, TEMP_DIR, REPORT_DIR]) {
    mkdirSync(directory, { recursive: true })
  }

  const entries = entryPoints()
  if (entries.length === 0) {
    console.error('package.json declares no entry points, so nothing was analysed')
    return 1
  }

  const missing = entries.filter(entry => !existsSync(entry.typesPath))
  if (missing.length > 0) {
    for (const entry of missing) {
      console.error(`the "${entry.subpath}" export declares types that tsup has not built: ${entry.typesPath}`)
    }
    console.error('\nRun "pnpm nx run narsil-ts:build" before checking the published API surface.')
    return 1
  }

  const problems: string[] = []
  const undocumented = new Map<string, string[]>()
  const unreachable = new Map<string, string[]>()
  const unlinked = new Map<string, string[]>()
  const exported = new Set<string>()

  for (const entry of entries) {
    const analysis = analyse(entry)
    problems.push(...analysis.problems)
    if (analysis.undocumented.length > 0) {
      undocumented.set(entry.subpath, analysis.undocumented)
    }
    if (analysis.unreachable.length > 0) {
      unreachable.set(entry.subpath, analysis.unreachable)
    }
    if (analysis.unlinked.length > 0) {
      unlinked.set(entry.subpath, analysis.unlinked)
    }
    inspectDocComments(entry, exported, problems)
  }

  for (const [subpath, names] of unreachable) {
    for (const name of new Set(names)) {
      if (exported.has(name)) continue
      problems.push(`${subpath}: ${name} shapes the published types, so export it from an entry point`)
    }
  }

  for (const [subpath, names] of unlinked) {
    for (const name of new Set(names)) {
      if (exported.has(name)) continue
      problems.push(`${subpath}: a TSDoc comment links to ${name}, which no entry point exports`)
    }
  }

  problems.push(...reconcileReports(entries, write))

  const summary = undocumentedSummary(undocumented)
  if (problems.length === 0 && summary.length === 0) {
    console.log(`${entries.length} entry points are documented and match etc/`)
    return 0
  }

  for (const line of summary) console.error(line)
  if (summary.length > 0 && problems.length > 0) console.error('')
  for (const problem of problems) console.error(problem)
  if (!write) console.error(`\n${WRITE_HINT}`)
  return 1
}

process.exit(run(process.argv.includes('--write')))
