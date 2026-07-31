import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = resolve(__dirname, '..', 'src', 'languages', 'snowball')
const DEFAULT_CACHE_DIR = resolve(__dirname, '..', 'node_modules', '.cache', 'narsil-snowball')

const COMPILER_REPOSITORY = 'https://github.com/snowballstem/snowball.git'
const COMPILER_COMMIT = '6772636350acfd63797e8cd24ff86c70fd2df6fc'

const DATA_REPOSITORY = 'https://github.com/snowballstem/snowball-data.git'
const DATA_COMMIT = 'a0ec0d0a2839ec885878868de20fcb63209d92b0'

const GENERATED_LANGUAGES = ['turkish']

const RUNTIME_IMPORT = "import { type Among, BaseStemmer } from './base-stemmer'"

interface Agreement {
  total: number
  agreed: number
  firstDisagreements: Array<[string, string, string]>
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function checkout(repository: string, commit: string, directory: string, only?: string[]): void {
  const fresh = !existsSync(join(directory, '.git'))
  if (fresh) {
    mkdirSync(directory, { recursive: true })
    run('git', ['init', '--quiet'], directory)
    run('git', ['remote', 'add', 'origin', repository], directory)
  }

  if (only !== undefined) {
    run('git', ['sparse-checkout', 'set', '--cone', ...only], directory)
  }

  if (!fresh) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf-8' }).trim()
    if (head === commit) return
  }

  const filter = only === undefined ? [] : ['--filter=blob:none']
  console.log(`fetching ${repository} at ${commit}`)
  try {
    run('git', ['fetch', '--quiet', '--depth', '1', ...filter, 'origin', commit], directory)
    run('git', ['checkout', '--quiet', 'FETCH_HEAD'], directory)
  } catch {
    run('git', ['fetch', '--quiet', ...filter, 'origin'], directory)
    run('git', ['checkout', '--quiet', commit], directory)
  }
}

function buildCompiler(directory: string): string {
  const compiler = join(directory, 'snowball')
  if (!existsSync(compiler)) {
    console.log('building the Snowball compiler')
    run('make', ['snowball'], directory)
  }
  return compiler
}

function className(language: string): string {
  return `${language.charAt(0).toUpperCase()}${language.slice(1)}Stemmer`
}

function stripGeneratorComments(source: string): string {
  return source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('// deno-lint-ignore'))
    .filter(line => !line.startsWith('// Generated from'))
    .join('\n')
}

function convertTypeAnnotations(source: string): string {
  return source
    .replace(/\b(const|let)\s+\/\*\*@type\s*\{Array<(\w+)>\}\*\/\s*(\w+)/g, '$1 $3: $2[]')
    .replace(/\b(const|let)\s+\/\*\*@type\s*\{(\w+)\}\*\/\s*(\w+)/g, '$1 $3: $2')
    .replace(/\/\*\*\s*@return\s*\{boolean\}\s*\*\/\s*\n(\s*)(#?\w+)\(\)\s*\{/g, '$1$2(): boolean {')
    .replace(
      /\/\*\*@return\{string\}\*\/\s*\n(\s*)stem\(\/\*\*@type \{string\}\*\/input\)\s*\{/g,
      '$1stem(input: string): string {',
    )
}

function convertModuleShape(source: string, language: string): string {
  const hoisted = source.replace("import B from './base-stemmer.js'", '')
  return `${RUNTIME_IMPORT}\n\n${hoisted}`
    .replace('export default class extends B {', `export class ${className(language)} extends BaseStemmer {`)
    .replace(/\n\s*stemWord = this\.stem;\n/, '\n')
}

function convert(generated: string, language: string): string {
  let source = stripGeneratorComments(generated)
  source = convertTypeAnnotations(source)
  source = source.replace(/^const (a_\d+) = \[/gm, 'const $1: Among[] = [')
  source = convertModuleShape(source, language)
  return source.trim()
}

function compilerVersionOf(generated: string): string {
  const match = /by Snowball (\S+)/.exec(generated)
  if (match === null) {
    throw new Error('the generated source carries no Snowball version banner')
  }
  return match[1]
}

function moduleText(language: string, compilerVersion: string, revision: string, body: string): string {
  const header = `/*
 * Generated from algorithms/${language}.sbl by the Snowball compiler ${compilerVersion}.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from ${COMPILER_REPOSITORY} at ${COMPILER_COMMIT},
 * verified against ${DATA_REPOSITORY} at ${DATA_COMMIT}.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision ${revision}
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */
`
  const footer = `
const shared = new ${className(language)}()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '${revision}'
`
  return `${header}\n${body}\n${footer}`
}

async function measureAgreement(candidatePath: string, language: string, dataDirectory: string): Promise<Agreement> {
  const module: { stem: (token: string) => string } = await import(candidatePath)
  const words = readFileSync(join(dataDirectory, language, 'voc.txt'), 'utf-8').split('\n')
  const expected = readFileSync(join(dataDirectory, language, 'output.txt'), 'utf-8').split('\n')

  let total = 0
  let agreed = 0
  const firstDisagreements: Array<[string, string, string]> = []

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.length === 0) continue
    total++
    const produced = module.stem(word)
    if (produced === expected[i]) {
      agreed++
    } else if (firstDisagreements.length < 10) {
      firstDisagreements.push([word, expected[i], produced])
    }
  }

  return { total, agreed, firstDisagreements }
}

async function generateLanguage(
  language: string,
  compiler: string,
  compilerDirectory: string,
  dataDirectory: string,
  scratch: string,
): Promise<boolean> {
  const algorithmPath = join(compilerDirectory, 'algorithms', `${language}.sbl`)
  const algorithm = readFileSync(algorithmPath, 'utf-8')

  execFileSync(compiler, [algorithmPath, '-js', '-o', join(scratch, language)])
  const generated = readFileSync(join(scratch, `${language}.js`), 'utf-8')

  const compilerVersion = compilerVersionOf(generated)
  const revision = createHash('sha256').update(`${compilerVersion}\n${algorithm}`).digest('hex').slice(0, 16)
  const text = moduleText(language, compilerVersion, revision, convert(generated, language))

  const candidatePath = join(OUTPUT_DIR, `${language}.candidate.ts`)
  writeFileSync(candidatePath, text)

  try {
    const { total, agreed, firstDisagreements } = await measureAgreement(candidatePath, language, dataDirectory)
    if (agreed !== total) {
      console.error(`${language}: ${agreed}/${total} published pairs, refusing to write`)
      for (const [word, want, got] of firstDisagreements) {
        console.error(`  ${word}: published ${want}, produced ${got}`)
      }
      return false
    }
    renameSync(candidatePath, join(OUTPUT_DIR, `${language}.ts`))
    console.log(`${language}: ${total}/${total} published pairs, revision ${revision}`)
    return true
  } finally {
    rmSync(candidatePath, { force: true })
  }
}

async function main(): Promise<void> {
  const cacheDirectory = process.env.NARSIL_SNOWBALL_CACHE_DIR ?? DEFAULT_CACHE_DIR
  const compilerDirectory = join(cacheDirectory, 'snowball')
  const dataDirectory = join(cacheDirectory, 'snowball-data')

  checkout(COMPILER_REPOSITORY, COMPILER_COMMIT, compilerDirectory)
  checkout(DATA_REPOSITORY, DATA_COMMIT, dataDirectory, GENERATED_LANGUAGES)
  const compiler = buildCompiler(compilerDirectory)

  const scratch = mkdtempSync(join(tmpdir(), 'narsil-snowball-'))
  let failed = false
  try {
    for (const language of GENERATED_LANGUAGES) {
      const written = await generateLanguage(language, compiler, compilerDirectory, dataDirectory, scratch)
      if (!written) failed = true
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (failed) process.exit(1)

  execFileSync('pnpm', ['exec', 'biome', 'check', '--write', OUTPUT_DIR], {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
