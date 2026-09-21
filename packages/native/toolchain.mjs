import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { devNull } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageDirectory = dirname(fileURLToPath(import.meta.url))
export const buildDirectory = join(packageDirectory, 'build')
export const TEST_LINK_FLAGS = ['-pthread']

export const LANGUAGE_FLAGS = ['-std=c11', '-ffp-contract=off', '-D_POSIX_C_SOURCE=200809L']
export const CORE_FLAGS = ['-O2', '-fvisibility=hidden']
export const POSITION_INDEPENDENT_FLAGS = ['-fPIC']
export const NODE_API_FLAGS = ['-DNAPI_VERSION=8']
export const WINDOWS_NODE_API_FLAGS = ['-DNAPI_EXTERN=']
export const TEST_FLAGS = ['-O1', '-g']

const WARNING_FLAGS = [
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Wformat=2',
  '-Wconversion',
  '-Wsign-conversion',
  '-Wimplicit-fallthrough',
  '-Wshadow',
  '-Wcast-qual',
  '-Wcast-align',
  '-Wstrict-prototypes',
  '-Wmissing-prototypes',
  '-Wdouble-promotion',
  '-Wundef',
  '-Wnull-dereference',
  '-Wvla',
]

const GCC_ONLY_WARNING_FLAGS = ['-Wcast-align=strict', '-Wtrampolines', '-Wbidi-chars=any']

const FORMATTED_DIRECTORIES = ['include', 'src', 'node', 'test']

function cFilesIn(directory, extensions) {
  if (!existsSync(join(packageDirectory, directory))) return []
  return readdirSync(join(packageDirectory, directory))
    .filter(name => extensions.some(extension => name.endsWith(extension)))
    .sort()
    .map(name => join(packageDirectory, directory, name))
}

export function coreSources() {
  return cFilesIn('src', ['.c'])
}

export function testSources() {
  return cFilesIn('test', ['.c'])
}

export function addonSources() {
  return cFilesIn('node', ['.c'])
}

export function formattedFiles() {
  return FORMATTED_DIRECTORIES.flatMap(directory => cFilesIn(directory, ['.c', '.h']))
}

export function nodeApiHeaderDirectory() {
  const require = createRequire(import.meta.url)
  return require('node-api-headers').include_dir
}

function compilesAsGcc(command, prefix) {
  const defines = execFileSync(command, [...prefix, '-dM', '-E', '-x', 'c', devNull], { encoding: 'utf8' })
  return defines.includes('#define __GNUC__ ') && !defines.includes('#define __clang__ ')
}

export function warningFlags(command, prefix = []) {
  const gccOnly = compilesAsGcc(command, prefix) ? GCC_ONLY_WARNING_FLAGS : []
  return [...WARNING_FLAGS, ...gccOnly, '-Werror']
}

function appleSdkFlags() {
  if (process.platform !== 'darwin') return []
  return ['-isysroot', execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim()]
}

function compileCommand(file, flags) {
  const object = join(buildDirectory, 'objects', `${basename(file, '.c')}.o`)
  return { directory: packageDirectory, file, arguments: ['cc', ...flags, '-c', file, '-o', object] }
}

export function writeCompileDatabase() {
  const shared = [
    ...LANGUAGE_FLAGS,
    ...NODE_API_FLAGS,
    ...WARNING_FLAGS,
    '-isystem',
    nodeApiHeaderDirectory(),
    ...appleSdkFlags(),
  ]
  const commands = [...coreSources(), ...addonSources()].map(file =>
    compileCommand(file, [...CORE_FLAGS, ...POSITION_INDEPENDENT_FLAGS, ...shared]),
  )
  for (const file of testSources()) {
    commands.push(compileCommand(file, [...TEST_FLAGS, ...shared]))
  }
  mkdirSync(buildDirectory, { recursive: true })
  const path = join(buildDirectory, 'compile_commands.json')
  writeFileSync(path, `${JSON.stringify(commands, null, 2)}\n`)
  return path
}
