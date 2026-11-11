import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeStemmerFile } from '../../snowball/native'
import { DEFAULT_MIN_TOKEN_LENGTH, DEFAULT_SPLIT_PATTERN } from '../../src/core/tokenizer/constants'
import type { LanguageModule } from '../../src/types/language'
import { type GeneratedFile, numberLines, writeOrCheck } from './c-source'
import { keepTable } from './language-tables'
import { NATIVE_LANGUAGES_DIR, NATIVE_PACKAGE_DIR, TS_LANGUAGES_DIR } from './paths'

const DATA_DIR = join(NATIVE_LANGUAGES_DIR, 'data')
const HEX_WORD_DIGITS = 16

interface ModuleShape {
  file: string
  module: LanguageModule
  snowball: boolean
}

function identifier(name: string): string {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error(`the language name "${name}" makes no C identifier`)
  return name.replaceAll('-', '_')
}

function isLanguageModule(value: unknown): value is LanguageModule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LanguageModule>
  return (
    typeof candidate.name === 'string' && typeof candidate.revision === 'string' && candidate.stopWords instanceof Set
  )
}

async function loadModules(): Promise<ModuleShape[]> {
  const files = readdirSync(TS_LANGUAGES_DIR)
    .filter(entry => entry.endsWith('.ts') && entry !== 'registry.ts')
    .map(entry => entry.slice(0, -3))
    .sort()
  const shapes: ModuleShape[] = []
  for (const file of files) {
    const exported: Record<string, unknown> = await import(pathToFileURL(join(TS_LANGUAGES_DIR, `${file}.ts`)).href)
    const modules = Object.values(exported).filter(isLanguageModule)
    if (modules.length !== 1) throw new Error(`${file}.ts exports ${modules.length} language modules`)
    const module = modules[0]
    if (module.name !== file) throw new Error(`${file}.ts names its language "${module.name}"`)
    const snowballPath = join(TS_LANGUAGES_DIR, 'snowball', `${file}.ts`)
    let snowball = false
    if (existsSync(snowballPath)) {
      const generated: { stem?: unknown } = await import(pathToFileURL(snowballPath).href)
      snowball = module.stemmer !== null && generated.stem === module.stemmer
    }
    shapes.push({ file, module, snowball })
  }
  return shapes
}

function stopWordTables(words: string[]): string {
  const offsets = [0]
  const units: number[] = []
  for (const word of words) {
    for (let i = 0; i < word.length; i++) units.push(word.charCodeAt(i))
    offsets.push(units.length)
  }
  if (units.length === 0) units.push(0)
  return `static const uint16_t stop_word_units[${units.length}] = {\n${numberLines(units)}\n};\n\nstatic const uint32_t stop_word_offsets[${offsets.length}] = {\n${numberLines(offsets)}\n};\n`
}

function hexWord(value: bigint): string {
  return `0x${value.toString(16).toUpperCase().padStart(HEX_WORD_DIGITS, '0')}ULL`
}

function languageFile(shape: ModuleShape): string {
  const { module, snowball } = shape
  const name = identifier(module.name)
  const tokenizer = module.tokenizer ?? {}
  const table = keepTable(tokenizer.splitPattern ?? DEFAULT_SPLIT_PATTERN)
  if (table.ranges.length === 0) throw new Error(`${module.name} keeps no character at all`)
  const words = [...module.stopWords].sort()
  const ngramSize = tokenizer.ngramSize === undefined || tokenizer.ngramSize < 1 ? 0 : Math.floor(tokenizer.ngramSize)
  const minTokenLength = tokenizer.minTokenLength ?? DEFAULT_MIN_TOKEN_LENGTH
  if (!Number.isInteger(minTokenLength) || minTokenLength < 0)
    throw new Error(`${module.name} has a bad minTokenLength`)
  const handStemmer = module.stemmer !== null && !snowball
  const includes = ['#include "../../analysis/languages.h"', '#include "declarations.h"']
  if (module.normalizer !== undefined || handStemmer) includes.push('#include "../rules.h"')
  if (snowball) includes.push(`#include "../snowball/${nativeStemmerFile(shape.file)}.h"`)
  return `${includes.join('\n')}

#include <stddef.h>
#include <stdint.h>

${stopWordTables(words)}
static const uint32_t keep_ranges[${table.ranges.length}] = {
${numberLines(table.ranges)}
};

const narsil_language narsil_language_${name} = {
  .name = "${module.name}",
  .revision = "${module.revision}",
  .stop_word_units = stop_word_units,
  .stop_word_offsets = stop_word_offsets,
  .stop_word_count = ${words.length},
  .ascii_keep = {${hexWord(table.asciiKeep[0])}, ${hexWord(table.asciiKeep[1])}},
  .keep_ranges = keep_ranges,
  .keep_range_count = ${table.ranges.length / 2},
  .splits_code_points = ${table.splitsCodePoints ? 1 : 0},
  .strips_possessive = ${tokenizer.stripPossessive ? 1 : 0},
  .normalises_diacritics = ${tokenizer.normalizeDiacritics ? 1 : 0},
  .min_token_length = ${minTokenLength},
  .ngram_size = ${ngramSize},
  .normalise = ${module.normalizer === undefined ? 'NULL' : `narsil_${name}_normalise`},
  .stem_by_rules = ${handStemmer ? `narsil_${name}_stem` : 'NULL'},
  .create_snowball = ${snowball ? `${shape.file.replaceAll('-', '_')}_create_env` : 'NULL'},
  .snowball_stem = ${snowball ? `${shape.file.replaceAll('-', '_')}_stem` : 'NULL'},
  .close_snowball = ${snowball ? `${shape.file.replaceAll('-', '_')}_close_env` : 'NULL'},
};
`
}

function declarationsFile(shapes: ModuleShape[]): string {
  const lines = shapes.map(shape => `extern const narsil_language narsil_language_${identifier(shape.module.name)};`)
  return `#ifndef NARSIL_LANGUAGES_DATA_DECLARATIONS_H
#define NARSIL_LANGUAGES_DATA_DECLARATIONS_H

#include "../../analysis/languages.h"

${lines.join('\n')}

#endif
`
}

function registryFile(shapes: ModuleShape[]): string {
  const ordered = [...shapes].sort((a, b) =>
    a.module.name < b.module.name ? -1 : a.module.name > b.module.name ? 1 : 0,
  )
  const entries = ordered.map(shape => `  &narsil_language_${identifier(shape.module.name)},`)
  return `#include "../../analysis/languages.h"
#include "declarations.h"

#include <stdint.h>

const narsil_language *const narsil_language_table[${ordered.length}] = {
${entries.join('\n')}
};

const uint32_t narsil_language_table_length = ${ordered.length};
`
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write')
  const shapes = await loadModules()
  if (write) mkdirSync(DATA_DIR, { recursive: true })
  const files: GeneratedFile[] = shapes.map(shape => ({
    path: join(DATA_DIR, `${shape.file}.c`),
    text: languageFile(shape),
  }))
  files.push({ path: join(DATA_DIR, 'declarations.h'), text: declarationsFile(shapes) })
  files.push({ path: join(DATA_DIR, 'registry.c'), text: registryFile(shapes) })
  const expected = new Set(files.map(file => file.path))
  const strays = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter(entry => !expected.has(join(DATA_DIR, entry))) : []
  for (const stray of strays) console.error(`${stray} in ${DATA_DIR} belongs to no language module`)
  const status = writeOrCheck(files, NATIVE_PACKAGE_DIR, write)
  process.exit(strays.length > 0 ? 1 : status)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
