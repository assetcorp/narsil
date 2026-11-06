import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nativeStemmerFile } from '../snowball/native'

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_]/
const WHITESPACE = /\s/
const GENERATED_REVISION = /\.revision="[^"]*"/
const GENERATED_REVISION_PLACEHOLDER = '.revision="recorded in languages.lock.json"'
const SNOWBALL_RUNTIME_FILES = ['api.c', 'api.h', 'snowball_runtime.h', 'utilities.c']
const SHARED_LANGUAGE_FILES = ['rules.c', 'rules.h']

interface NativeDirectories {
  include: string
  analysis: string
  unicode: string
  languages: string
  data: string
  snowball: string
}

function directoriesBeside(packageDirectory: string): NativeDirectories {
  const native = resolve(packageDirectory, '..', 'native')
  const languages = join(native, 'src', 'languages')
  return {
    include: join(native, 'include'),
    analysis: join(native, 'src', 'analysis'),
    unicode: join(native, 'src', 'unicode'),
    languages,
    data: join(languages, 'data'),
    snowball: join(languages, 'snowball'),
  }
}

function endOfQuoted(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length && source[index] !== quote) {
    index += source[index] === '\\' ? 2 : 1
  }
  return Math.min(index + 1, source.length)
}

function endOfComment(source: string, start: number): number {
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start)
    return end === -1 ? source.length : end
  }
  const end = source.indexOf('*/', start + 2)
  return end === -1 ? source.length : end + 2
}

function opensComment(source: string, index: number): boolean {
  return source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*')
}

export function normaliseCSource(source: string): string {
  let output = ''
  let index = 0
  let pendingSpace = false
  let atLineStart = true
  let inDirective = false
  while (index < source.length) {
    const character = source[index]
    if (opensComment(source, index)) {
      index = endOfComment(source, index)
      pendingSpace = true
      continue
    }
    if (character === '\\' && source[index + 1] === '\n') {
      index += 2
      pendingSpace = true
      continue
    }
    if (character === '\n') {
      if (inDirective) output += '\n'
      inDirective = false
      atLineStart = true
      pendingSpace = false
      index++
      continue
    }
    if (WHITESPACE.test(character)) {
      pendingSpace = true
      index++
      continue
    }
    if (character === '#' && atLineStart) {
      if (output.length > 0 && !output.endsWith('\n')) output += '\n'
      inDirective = true
    }
    const previous = output.at(-1) ?? ''
    if (pendingSpace && IDENTIFIER_CHARACTER.test(previous) && IDENTIFIER_CHARACTER.test(character)) output += ' '
    pendingSpace = false
    atLineStart = false
    const end = character === '"' || character === "'" ? endOfQuoted(source, index) : index + 1
    output += source.slice(index, end)
    index = end
  }
  return output
}

function readNormalised(path: string): string {
  return normaliseCSource(readFileSync(path, 'utf-8'))
}

function cFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.endsWith('.c') || entry.name.endsWith('.h')))
    .map(entry => join(directory, entry.name))
}

export function sharedNativeSources(packageDirectory: string): Map<string, string> {
  const directories = directoriesBeside(packageDirectory)
  const paths = [
    join(directories.include, 'narsil_analysis.h'),
    ...cFilesIn(directories.analysis),
    ...cFilesIn(directories.unicode),
    ...SHARED_LANGUAGE_FILES.map(name => join(directories.languages, name)),
    ...SNOWBALL_RUNTIME_FILES.map(name => join(directories.snowball, name)),
  ]
  const sources = new Map<string, string>()
  for (const path of paths) sources.set(path, readNormalised(path))
  return sources
}

function definesRulesFor(source: string, identifier: string): boolean {
  return new RegExp(`\\bnarsil_${identifier}_(normalise|stem)\\(`).test(source)
}

export function languageNativeSources(packageDirectory: string, language: string): Map<string, string> {
  const directories = directoriesBeside(packageDirectory)
  const sources = new Map<string, string>()
  const dataPath = join(directories.data, `${language}.c`)
  if (!existsSync(dataPath)) {
    throw new Error(`${language} has no generated C data. Run "pnpm nx run narsil-ts:native-analysis:write" first.`)
  }
  sources.set(dataPath, readNormalised(dataPath).replace(GENERATED_REVISION, GENERATED_REVISION_PLACEHOLDER))
  for (const extension of ['.c', '.h']) {
    const snowballPath = join(directories.snowball, `${nativeStemmerFile(language)}${extension}`)
    if (existsSync(snowballPath)) sources.set(snowballPath, readNormalised(snowballPath))
  }
  const identifier = language.replaceAll('-', '_')
  for (const path of cFilesIn(directories.languages)) {
    if (!path.endsWith('.c') || SHARED_LANGUAGE_FILES.some(name => path.endsWith(`/${name}`))) continue
    const normalised = readNormalised(path)
    if (definesRulesFor(normalised, identifier)) sources.set(path, normalised)
  }
  return sources
}
