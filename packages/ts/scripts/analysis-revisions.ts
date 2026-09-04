import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { normaliseTokenizerSource } from './analysis-revision-tokenizer'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(scriptDirectory, '..')
const LANGUAGES_DIR = join(PACKAGE_DIR, 'src', 'languages')
const TOKENIZER_DIR = join(PACKAGE_DIR, 'src', 'core', 'tokenizer')
const TOKENIZER_CONSTANTS_PATH = join(TOKENIZER_DIR, 'constants.ts')
const LOCK_PATH = join(PACKAGE_DIR, 'languages.lock.json')
const REVISION_PLACEHOLDER = 'revision: "recorded in languages.lock.json"'
const REVISION_PROPERTY = /revision:\s*(['"])[^'"]*\1/
const DECLARED_REVISION = /^ {2}revision: '([^']*)',$/m

interface LockEntry {
  revision: string
  fingerprint: string
}

interface Lock {
  tokenizer: string
  languages: Record<string, LockEntry>
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

function moduleNames(): string[] {
  return readdirSync(LANGUAGES_DIR)
    .filter(entry => entry.endsWith('.ts') && entry !== 'registry.ts')
    .map(entry => entry.slice(0, -3))
    .sort()
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.ESNext, true)
}

function localImports(sourceFile: ts.SourceFile, fromPath: string): string[] {
  const resolved: string[] = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const candidate = `${resolve(dirname(fromPath), specifier)}.ts`
    if (!candidate.startsWith(`${LANGUAGES_DIR}/`) || !existsSync(candidate)) continue
    resolved.push(candidate)
  }
  return resolved
}

function normalisedCode(sourceFile: ts.SourceFile, blankRevision: boolean): string {
  const printed = printer.printFile(sourceFile)
  return blankRevision ? printed.replace(REVISION_PROPERTY, REVISION_PLACEHOLDER) : printed
}

function analysisSources(language: string): Map<string, string> {
  const collected = new Map<string, string>()
  const entryPath = join(LANGUAGES_DIR, `${language}.ts`)
  const pending = [entryPath]
  while (pending.length > 0) {
    const path = pending.shift()
    if (path === undefined || collected.has(path)) continue
    const sourceFile = parse(path)
    collected.set(path, normalisedCode(sourceFile, path === entryPath))
    pending.push(...localImports(sourceFile, path))
  }
  return collected
}

function digestSources(sources: Map<string, string>): string {
  const digest = createHash('sha256')
  for (const path of [...sources.keys()].sort()) {
    digest.update(relative(PACKAGE_DIR, path))
    digest.update('\n')
    digest.update(sources.get(path) ?? '')
    digest.update('\n')
  }
  return digest.digest('hex').slice(0, 16)
}

function typeScriptFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...typeScriptFiles(path))
    } else if (entry.name.endsWith('.ts')) {
      found.push(path)
    }
  }
  return found
}

function tokenizerCode(path: string): string {
  return normaliseTokenizerSource(path, readFileSync(path, 'utf-8'), TOKENIZER_CONSTANTS_PATH)
}

function tokenizerFingerprint(): string {
  const sources = new Map<string, string>()
  for (const path of typeScriptFiles(TOKENIZER_DIR)) {
    sources.set(path, tokenizerCode(path))
  }
  return digestSources(sources)
}

function ownFingerprint(language: string): string {
  return digestSources(analysisSources(language))
}

function combine(own: string, tokenizer: string): string {
  return createHash('sha256').update(`${tokenizer}:${own}`).digest('hex').slice(0, 16)
}

function declaredRevision(language: string): string {
  const source = readFileSync(join(LANGUAGES_DIR, `${language}.ts`), 'utf-8')
  const match = DECLARED_REVISION.exec(source)
  if (match === null) {
    throw new Error(`${language}.ts declares no revision literal`)
  }
  return match[1]
}

function setDeclaredRevision(language: string, revision: string): void {
  const path = join(LANGUAGES_DIR, `${language}.ts`)
  const source = readFileSync(path, 'utf-8')
  writeFileSync(path, source.replace(DECLARED_REVISION, `  revision: '${revision}',`))
}

function readLock(): Lock | null {
  if (!existsSync(LOCK_PATH)) return null
  const parsed: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('languages.lock.json is not an object')
  }
  const { tokenizer, languages } = parsed as Record<string, unknown>
  if (typeof tokenizer !== 'string') {
    throw new Error('languages.lock.json records no tokenizer fingerprint')
  }
  if (typeof languages !== 'object' || languages === null) {
    throw new Error('languages.lock.json records no languages object')
  }
  const lock: Lock = { tokenizer, languages: {} }
  for (const [language, entry] of Object.entries(languages as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`languages.lock.json entry for ${language} is not an object`)
    }
    const { revision, fingerprint: recorded } = entry as Record<string, unknown>
    if (typeof revision !== 'string' || typeof recorded !== 'string') {
      throw new Error(`languages.lock.json entry for ${language} is incomplete`)
    }
    lock.languages[language] = { revision, fingerprint: recorded }
  }
  return lock
}

function writeLock(lock: Lock): void {
  const ordered: Record<string, LockEntry> = {}
  for (const language of Object.keys(lock.languages).sort()) {
    ordered[language] = lock.languages[language]
  }
  writeFileSync(LOCK_PATH, `${JSON.stringify({ tokenizer: lock.tokenizer, languages: ordered }, null, 2)}\n`)
}

function currentLock(tokenizer: string): Lock {
  const lock: Lock = { tokenizer, languages: {} }
  for (const language of moduleNames()) {
    lock.languages[language] = {
      revision: declaredRevision(language),
      fingerprint: combine(ownFingerprint(language), tokenizer),
    }
  }
  return lock
}

const TOKENIZER_CHANGED = 'src/core/tokenizer/ changed, so every language analyses text differently'

function check(): number {
  const recorded = readLock()
  if (recorded === null) {
    console.error('languages.lock.json is missing. Run "pnpm nx run narsil-ts:revisions:write" to record one.')
    return 1
  }
  const tokenizer = tokenizerFingerprint()
  const current = currentLock(tokenizer)
  const problems: string[] = []
  let tokenizerOnly = 0

  for (const language of Object.keys(current.languages)) {
    const entry = current.languages[language]
    const previous = recorded.languages[language]
    if (previous === undefined) {
      problems.push(`${language}: not recorded in the lock file`)
      continue
    }
    if (previous.fingerprint === entry.fingerprint && previous.revision === entry.revision) continue
    const ownSourcesMatch = previous.fingerprint === combine(ownFingerprint(language), recorded.tokenizer)
    if (ownSourcesMatch && previous.revision === entry.revision) {
      tokenizerOnly++
      continue
    }
    if (previous.fingerprint !== entry.fingerprint && previous.revision === entry.revision) {
      problems.push(`${language}: analysis changed while revision stayed ${entry.revision}`)
      continue
    }
    problems.push(`${language}: lock file is out of date`)
  }

  for (const language of Object.keys(recorded.languages)) {
    if (current.languages[language] === undefined) {
      problems.push(`${language}: recorded in the lock file but the module is gone`)
    }
  }

  if (recorded.tokenizer !== tokenizer) {
    problems.unshift(`${TOKENIZER_CHANGED}: ${tokenizerOnly} revisions must bump`)
  }

  if (problems.length === 0) {
    console.log(`${Object.keys(current.languages).length} language modules match languages.lock.json`)
    return 0
  }

  for (const problem of problems) console.error(problem)
  console.error(
    '\nRun "pnpm nx run narsil-ts:revisions:write" to bump every changed revision and update the lock file.',
  )
  return 1
}

function write(): number {
  const recorded = readLock()
  const tokenizer = tokenizerFingerprint()

  if (recorded === null) {
    writeLock(currentLock(tokenizer))
    console.log(`recorded ${moduleNames().length} language modules in languages.lock.json`)
    return 0
  }

  const bumped: string[] = []
  let tokenizerOnly = 0

  for (const language of moduleNames()) {
    const own = ownFingerprint(language)
    const current = combine(own, tokenizer)
    const previous = recorded.languages[language]
    if (previous === undefined || previous.fingerprint === current) continue
    setDeclaredRevision(language, current)
    if (previous.fingerprint === combine(own, recorded.tokenizer)) {
      tokenizerOnly++
    } else {
      bumped.push(`${language}: ${previous.revision} -> ${current}`)
    }
  }

  writeLock(currentLock(tokenizer))

  if (tokenizerOnly > 0) {
    console.log(`${TOKENIZER_CHANGED}: bumped ${tokenizerOnly} revisions`)
  }
  for (const entry of bumped) console.log(entry)
  if (tokenizerOnly === 0 && bumped.length === 0) {
    console.log('languages.lock.json was already current')
  }
  return 0
}

process.exit(process.argv.includes('--write') ? write() : check())
