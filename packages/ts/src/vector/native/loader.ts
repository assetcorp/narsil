import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { NativeCore } from './types'

const NATIVE_CORE_ABI_VERSION = 1
const BINARY_FILE_NAME = 'narsil-core.node'
const MUSL_DIRECTORY = 'musl'
const PLATFORMS_WITH_A_BINARY = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
])

let loaded: NativeCore | null | undefined

function usesMuslLibc(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    return report.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

function publishedBinaryPath(require: NodeJS.Require): string | null {
  const target = `${process.platform}-${process.arch}`
  if (!PLATFORMS_WITH_A_BINARY.has(target)) return null
  try {
    const manifest = require.resolve(`@delali/narsil-native-${target}/package.json`)
    const segments =
      process.platform === 'linux' && usesMuslLibc() ? [MUSL_DIRECTORY, BINARY_FILE_NAME] : [BINARY_FILE_NAME]
    return join(dirname(manifest), ...segments)
  } catch {
    return null
  }
}

function binaryPath(require: NodeJS.Require): string | null {
  const named = process.env.NARSIL_NATIVE_CORE_PATH
  const path = named !== undefined && named.length > 0 ? named : publishedBinaryPath(require)
  return path !== null && existsSync(path) ? path : null
}

export function loadNativeCore(): NativeCore | null {
  if (loaded !== undefined) return loaded
  loaded = null
  if (process.env.NARSIL_SEARCH_BACKEND === 'wasm') return loaded
  try {
    const require = createRequire(import.meta.url)
    const path = binaryPath(require)
    if (path === null) return loaded
    const core = require(path) as NativeCore
    if (typeof core.abiVersion === 'function' && core.abiVersion() === NATIVE_CORE_ABI_VERSION) loaded = core
  } catch {
    loaded = null
  }
  return loaded
}
