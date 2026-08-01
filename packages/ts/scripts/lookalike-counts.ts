import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize } from '../src/core/tokenizer'
import { azerbaijani } from '../src/languages/azerbaijani'
import { bambara } from '../src/languages/bambara'
import { belarusian } from '../src/languages/belarusian'
import { bulgarian } from '../src/languages/bulgarian'
import { dagbani } from '../src/languages/dagbani'
import { ewe } from '../src/languages/ewe'
import { guarani } from '../src/languages/guarani'
import { hawaiian } from '../src/languages/hawaiian'
import { kazakh } from '../src/languages/kazakh'
import { kyrgyz } from '../src/languages/kyrgyz'
import { lingala } from '../src/languages/lingala'
import { macedonian } from '../src/languages/macedonian'
import { russian } from '../src/languages/russian'
import { samoan } from '../src/languages/samoan'
import { serbian } from '../src/languages/serbian'
import { tatar } from '../src/languages/tatar'
import { tongan } from '../src/languages/tongan'
import { twi } from '../src/languages/twi'
import { ukrainian } from '../src/languages/ukrainian'
import { wolof } from '../src/languages/wolof'
import type { LanguageModule } from '../src/types/language'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(scriptDirectory, '..')
const RECORD_PATH = join(PACKAGE_DIR, 'languages.lookalikes.json')
const USER_AGENT = 'narsil-lookalike-counts (https://github.com/assetcorp/narsil)'
const SAMPLE_SIZE = 30
const SUBSTITUTION_BAR = 139
const REQUEST_SPACING_MS = 250

interface Confusable {
  letter: string
  lookalikes: string[]
}

interface LanguageCheck {
  wiki: string
  confusables: Confusable[]
  mixedScript?: true
}

interface LetterCount {
  letter: string
  correct: number
  substituted: Record<string, number>
}

interface LanguageRecord {
  wiki: string
  articles: Array<{ title: string; revision: number }>
  characters: number
  counts: LetterCount[]
}

type Record_ = Record<string, LanguageRecord>

const OPEN_E: Confusable = { letter: '\u025B', lookalikes: ['\u03B5', '\u0511'] }
const OPEN_O: Confusable = { letter: '\u0254', lookalikes: ['\u037B', '\u2184', '\u05DB'] }
const ENG: Confusable = { letter: '\u014B', lookalikes: ['\u03B7', '\u0273'] }
const D_HOOK: Confusable = { letter: '\u0256', lookalikes: ['\u00F0'] }
const SCHWA: Confusable = { letter: '\u0259', lookalikes: ['\u01DD', '\u04D9'] }
const CYRILLIC_SCHWA: Confusable = { letter: '\u04D9', lookalikes: ['\u0259', '\u01DD'] }
const CYRILLIC_ENG: Confusable = { letter: '\u04A3', lookalikes: ['\u014B'] }
const CYRILLIC_HOMOGLYPHS: Confusable[] = [
  { letter: '\u0430', lookalikes: ['a'] },
  { letter: '\u0435', lookalikes: ['e'] },
  { letter: '\u043E', lookalikes: ['o'] },
  { letter: '\u0440', lookalikes: ['p'] },
  { letter: '\u0441', lookalikes: ['c'] },
  { letter: '\u0443', lookalikes: ['y'] },
  { letter: '\u0445', lookalikes: ['x'] },
  { letter: '\u0456', lookalikes: ['i'] },
  { letter: '\u0458', lookalikes: ['j'] },
  { letter: '\u0455', lookalikes: ['s'] },
]
const OKINA: Confusable = { letter: '\u02BB', lookalikes: ['\u2018', '\u2019'] }
const PUSO: Confusable = { letter: "'", lookalikes: ['\uA78C'] }

const registry: Record<string, LanguageModule> = {
  azerbaijani,
  bambara,
  belarusian,
  bulgarian,
  dagbani,
  ewe,
  guarani,
  hawaiian,
  kazakh,
  kyrgyz,
  lingala,
  macedonian,
  russian,
  samoan,
  serbian,
  tatar,
  tongan,
  twi,
  ukrainian,
  wolof,
}

const CHECKS: Record<string, LanguageCheck> = {
  ewe: { wiki: 'ee', confusables: [D_HOOK, OPEN_E, OPEN_O, ENG] },
  twi: { wiki: 'tw', confusables: [OPEN_E, OPEN_O, ENG] },
  dagbani: { wiki: 'dag', confusables: [OPEN_E, OPEN_O, ENG] },
  guarani: { wiki: 'gn', confusables: [PUSO] },
  wolof: { wiki: 'wo', confusables: [ENG] },
  bambara: { wiki: 'bm', confusables: [OPEN_E, OPEN_O, ENG] },
  lingala: { wiki: 'ln', confusables: [OPEN_E, OPEN_O] },
  azerbaijani: { wiki: 'az', confusables: [SCHWA] },
  belarusian: { wiki: 'be', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  bulgarian: { wiki: 'bg', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  kazakh: { wiki: 'kk', confusables: [CYRILLIC_SCHWA, CYRILLIC_ENG, ...CYRILLIC_HOMOGLYPHS], mixedScript: true },
  kyrgyz: { wiki: 'ky', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  macedonian: { wiki: 'mk', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  russian: { wiki: 'ru', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  serbian: { wiki: 'sr', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  tatar: { wiki: 'tt', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  ukrainian: { wiki: 'uk', confusables: CYRILLIC_HOMOGLYPHS, mixedScript: true },
  hawaiian: { wiki: 'haw', confusables: [OKINA] },
  samoan: { wiki: 'sm', confusables: [OKINA] },
  tongan: { wiki: 'to', confusables: [OKINA] },
}

const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u
const LATIN_LETTER = /\p{Script=Latin}/u
const WORD_SPLIT = /[^\p{L}\p{M}]+/u

function countMixedScript(text: string, confusables: Confusable[]): LetterCount[] {
  const strays = new Map<string, number>()
  for (const token of text.split(WORD_SPLIT)) {
    if (token.length === 0) continue
    let cyrillic = 0
    const latin: string[] = []
    for (const character of token.toLowerCase()) {
      if (CYRILLIC_LETTER.test(character)) cyrillic++
      else if (LATIN_LETTER.test(character)) latin.push(character)
    }
    if (latin.length === 0 || cyrillic <= latin.length) continue
    for (const character of latin) strays.set(character, (strays.get(character) ?? 0) + 1)
  }
  return confusables.map(confusable => {
    const substituted: Record<string, number> = {}
    for (const lookalike of confusable.lookalikes) {
      substituted[lookalike] = strays.get(lookalike) ?? 0
    }
    return { letter: confusable.letter, correct: occurrences(text, confusable.letter), substituted }
  })
}

async function wikiRequest(wiki: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://${wiki}.wikipedia.org/w/api.php`)
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()
  await new Promise(settle => setTimeout(settle, REQUEST_SPACING_MS))
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`${wiki}.wikipedia.org answered ${response.status}`)
  }
  return response.json()
}

function pagesOf(payload: unknown): Array<Record<string, unknown>> {
  if (typeof payload !== 'object' || payload === null) return []
  const query = (payload as Record<string, unknown>).query
  if (typeof query !== 'object' || query === null) return []
  const pages = (query as Record<string, unknown>).pages
  return Array.isArray(pages) ? (pages as Array<Record<string, unknown>>) : []
}

async function randomTitles(wiki: string): Promise<string[]> {
  const payload = await wikiRequest(wiki, {
    action: 'query',
    list: 'random',
    rnnamespace: '0',
    rnlimit: String(SAMPLE_SIZE),
  })
  if (typeof payload !== 'object' || payload === null) return []
  const query = (payload as Record<string, unknown>).query
  if (typeof query !== 'object' || query === null) return []
  const random = (query as Record<string, unknown>).random
  if (!Array.isArray(random)) return []
  return random
    .map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).title : undefined))
    .filter((title): title is string => typeof title === 'string')
}

async function revisionOfTitle(wiki: string, title: string): Promise<number | null> {
  const payload = await wikiRequest(wiki, { action: 'query', prop: 'revisions', titles: title })
  const page = pagesOf(payload)[0]
  if (page === undefined) return null
  const revisions = page.revisions
  if (!Array.isArray(revisions) || revisions.length === 0) return null
  const first = revisions[0]
  const revid = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).revid : undefined
  return typeof revid === 'number' ? revid : null
}

async function textOfRevision(wiki: string, revision: number): Promise<string | null> {
  const payload = await wikiRequest(wiki, { action: 'parse', oldid: String(revision), prop: 'text' })
  if (typeof payload !== 'object' || payload === null) return null
  const parse = (payload as Record<string, unknown>).parse
  if (typeof parse !== 'object' || parse === null) return null
  const rendered = (parse as Record<string, unknown>).text
  if (typeof rendered !== 'string') return null
  return rendered
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
}

function occurrences(text: string, character: string): number {
  let total = 0
  for (const found of text) {
    if (found.toLowerCase() === character) total++
  }
  return total
}

function countCharacters(text: string, confusables: Confusable[]): LetterCount[] {
  return confusables.map(confusable => {
    const substituted: Record<string, number> = {}
    for (const lookalike of confusable.lookalikes) {
      substituted[lookalike] = occurrences(text, lookalike)
    }
    return { letter: confusable.letter, correct: occurrences(text, confusable.letter), substituted }
  })
}

function totalSubstituted(count: LetterCount): number {
  return Object.values(count.substituted).reduce((sum, value) => sum + value, 0)
}

function describe(language: string, record: LanguageRecord): string[] {
  const lines = [
    `${language} (${record.wiki}.wikipedia, ${record.articles.length} articles, ${record.characters} characters)`,
  ]
  for (const count of record.counts) {
    const parts = Object.entries(count.substituted).map(([lookalike, total]) => `${lookalike} ${total}`)
    lines.push(`  ${count.letter} ${count.correct} correct, substituted: ${parts.join(', ')}`)
  }
  const worst = Math.max(0, ...record.counts.map(totalSubstituted))
  lines.push(`  worst substitution total ${worst} against the bar of ${SUBSTITUTION_BAR}`)
  return lines
}

function readRecord(): Record_ | null {
  if (!existsSync(RECORD_PATH)) return null
  const parsed: unknown = JSON.parse(readFileSync(RECORD_PATH, 'utf-8'))
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record_) : null
}

async function collect(): Promise<number> {
  const record: Record_ = {}
  for (const [language, check] of Object.entries(CHECKS)) {
    const articles: Array<{ title: string; revision: number }> = []
    let corpus = ''
    for (const title of await randomTitles(check.wiki)) {
      const revision = await revisionOfTitle(check.wiki, title)
      if (revision === null) continue
      const text = await textOfRevision(check.wiki, revision)
      if (text === null || text.length === 0) continue
      articles.push({ title, revision })
      corpus += text
    }
    record[language] = {
      wiki: check.wiki,
      articles,
      characters: corpus.length,
      counts:
        check.mixedScript === true
          ? countMixedScript(corpus, check.confusables)
          : countCharacters(corpus, check.confusables),
    }
    for (const line of describe(language, record[language])) console.log(line)
  }
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\nrecorded ${Object.keys(record).length} languages in languages.lookalikes.json`)
  return 0
}

function analyse(language: string, token: string): string | undefined {
  const module = registry[language]
  if (module === undefined) return undefined
  return tokenize(token, module, { stem: false, removeStopWords: false }).tokens[0]?.token
}

function verify(): number {
  const recorded = readRecord()
  if (recorded === null) {
    console.error('languages.lookalikes.json is missing. Run "pnpm nx run narsil-ts:lookalikes:collect" to record one.')
    return 1
  }
  const problems: string[] = []

  for (const [language, entry] of Object.entries(recorded)) {
    for (const line of describe(language, entry)) console.log(line)
    for (const count of entry.counts) {
      for (const [lookalike, total] of Object.entries(count.substituted)) {
        if (total < SUBSTITUTION_BAR) continue
        const correct = analyse(language, `a${count.letter}a`)
        const substituted = analyse(language, `a${lookalike}a`)
        if (correct === undefined || substituted === undefined) {
          problems.push(`${language}: no module is registered to analyse`)
          continue
        }
        if (correct !== substituted) {
          problems.push(
            `${language}: ${lookalike} appears ${total} times for ${count.letter} and analysis keeps them apart as ${substituted} and ${correct}`,
          )
        }
      }
    }
  }

  if (problems.length === 0) {
    console.log(`\nevery substitution past the bar of ${SUBSTITUTION_BAR} folds onto its letter`)
    return 0
  }
  for (const problem of problems) console.error(problem)
  return 1
}

if (process.argv.includes('--collect')) {
  collect()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
} else {
  process.exit(verify())
}
