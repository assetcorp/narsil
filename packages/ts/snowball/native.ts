import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { endianness } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const NATIVE_OUTPUT_DIR = resolve(__dirname, '..', '..', 'native', 'src', 'languages', 'snowball')
const STEM_CHECK_SOURCE = join(__dirname, 'stem-check.c')

const RUNTIME_FILES = ['api.h', 'api.c', 'snowball_runtime.h', 'utilities.c']
const NARROW_SYMBOL = 'typedef unsigned char symbol;'
const WIDE_SYMBOL = 'typedef unsigned short symbol;'
const UNIT_BYTES = 2
const LENGTH_BYTES = 4
const STEM_CHECK_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024

const VENDORED_WARNINGS = `#if defined(__GNUC__)
#pragma GCC diagnostic ignored "-Wcast-align"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif
`

export interface NativeSource {
  name: string
  text: string
}

export interface NativeProvenance {
  compilerVersion: string
  compilerRepository: string
  compilerCommit: string
  dataRepository: string
  dataCommit: string
}

function banner(origin: string, provenance: NativeProvenance): string {
  return `/*
 * ${origin} by the Snowball compiler ${provenance.compilerVersion}, with each symbol widened to a
 * UTF-16 code unit so that the stemmer reads the same units as the TypeScript stemmer.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors. The NOTICE file at the root
 * of the repository carries the licence. Source from ${provenance.compilerRepository} at
 * ${provenance.compilerCommit}, verified against ${provenance.dataRepository} at
 * ${provenance.dataCommit}.
 *
 * packages/ts/snowball/build.ts writes this file, so regenerate it with that script.
 */
`
}

function withoutGeneratorBanner(source: string): string {
  return source.replace(/^\/\* Generated from \S+ by Snowball \S+ - https:\/\/snowballstem\.org\/ \*\/\n\n?/, '')
}

function vendored(name: string, source: string, origin: string, provenance: NativeProvenance): NativeSource {
  const quiet = name.endsWith('.c') ? `${VENDORED_WARNINGS}\n` : ''
  return { name, text: `${banner(origin, provenance)}\n${quiet}${source}` }
}

export function nativeStemmerFile(language: string): string {
  return `${language}_stemmer`
}

export function nativeRuntime(compilerDirectory: string, provenance: NativeProvenance): NativeSource[] {
  return RUNTIME_FILES.map(name => {
    let source = readFileSync(join(compilerDirectory, 'runtime', name), 'utf-8')
    if (name === 'api.h') {
      if (!source.includes(NARROW_SYMBOL)) throw new Error('runtime/api.h no longer declares the symbol type')
      source = source.replace(NARROW_SYMBOL, WIDE_SYMBOL)
    }
    return vendored(name, source, `Copied from runtime/${name}`, provenance)
  })
}

export function nativeStemmer(
  language: string,
  compiler: string,
  algorithmPath: string,
  scratch: string,
  provenance: NativeProvenance,
): NativeSource[] {
  const output = join(scratch, `${language}-native`)
  mkdirSync(output, { recursive: true })
  const stem = nativeStemmerFile(language)
  execFileSync(compiler, [algorithmPath, '-w', '-eprefix', `${language}_`, '-r', '.', '-o', join(output, stem)])
  return ['c', 'h'].map(extension => {
    const name = `${stem}.${extension}`
    const source = withoutGeneratorBanner(readFileSync(join(output, name), 'utf-8'))
    return vendored(name, source, `Generated from algorithms/${language}.sbl`, provenance)
  })
}

function encodeWords(words: readonly string[]): Buffer {
  let size = 0
  for (const word of words) size += LENGTH_BYTES + word.length * UNIT_BYTES
  const buffer = Buffer.alloc(size)
  let offset = 0
  for (const word of words) {
    offset = buffer.writeUInt32LE(word.length, offset)
    for (let i = 0; i < word.length; i++) offset = buffer.writeUInt16LE(word.charCodeAt(i), offset)
  }
  return buffer
}

function decodeWords(buffer: Buffer, expected: number): string[] {
  const words: string[] = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + LENGTH_BYTES > buffer.length) throw new Error('the stem check cut a length short')
    const length = buffer.readUInt32LE(offset)
    offset += LENGTH_BYTES
    if (offset + length * UNIT_BYTES > buffer.length) throw new Error('the stem check cut a stem short')
    const units = new Array<number>(length)
    for (let i = 0; i < length; i++) units[i] = buffer.readUInt16LE(offset + i * UNIT_BYTES)
    offset += length * UNIT_BYTES
    words.push(String.fromCharCode(...units))
  }
  if (words.length !== expected) throw new Error(`the stem check returned ${words.length} of ${expected} stems`)
  return words
}

export function stemNatively(
  language: string,
  sources: readonly NativeSource[],
  words: readonly string[],
  scratch: string,
): string[] {
  if (endianness() !== 'LE') throw new Error('the stem check exchanges little-endian units')
  const directory = join(scratch, `${language}-check`)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  for (const source of sources) writeFileSync(join(directory, source.name), source.text)
  const binary = join(directory, 'stem-check')
  execFileSync('cc', [
    '-std=c11',
    '-O1',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-DSTEMMER=${language}`,
    `-DSTEMMER_HEADER="${nativeStemmerFile(language)}.h"`,
    '-I',
    directory,
    STEM_CHECK_SOURCE,
    join(directory, `${nativeStemmerFile(language)}.c`),
    join(directory, 'api.c'),
    join(directory, 'utilities.c'),
    '-o',
    binary,
  ])
  const output = execFileSync(binary, [], { input: encodeWords(words), maxBuffer: STEM_CHECK_OUTPUT_LIMIT_BYTES })
  return decodeWords(output, words.length)
}

export function writeNativeSources(sources: readonly NativeSource[]): void {
  mkdirSync(NATIVE_OUTPUT_DIR, { recursive: true })
  const expected = new Set(sources.map(source => source.name))
  for (const entry of existsSync(NATIVE_OUTPUT_DIR) ? readdirSync(NATIVE_OUTPUT_DIR) : []) {
    if (!expected.has(entry)) rmSync(join(NATIVE_OUTPUT_DIR, entry))
  }
  for (const source of sources) writeFileSync(join(NATIVE_OUTPUT_DIR, source.name), source.text)
}
