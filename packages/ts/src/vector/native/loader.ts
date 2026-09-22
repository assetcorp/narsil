import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeCore } from './types'

const NATIVE_CORE_ABI_VERSION = 2
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

function namedBinaryPath(): string | null {
  const named = process.env.NARSIL_NATIVE_CORE_PATH
  return named !== undefined && named.length > 0 ? named : null
}

function refuseToSearchWithoutTheCore(reason: string): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `NARSIL_REQUIRE_NATIVE_CORE is 1, yet ${reason}`, {
    platform: `${process.platform}-${process.arch}`,
  })
}

function requestedBackend(): 'native' | 'wasm' | null {
  const raw = process.env.NARSIL_SEARCH_BACKEND
  if (raw === undefined || raw.trim().length === 0) return null
  const named = raw.trim().toLowerCase()
  if (named === 'native' || named === 'wasm') return named
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `NARSIL_SEARCH_BACKEND takes either "native" or "wasm", while this environment sets it to "${raw}"`,
    { value: raw, backends: ['native', 'wasm'] },
  )
}

function reportMissingCore(reason: string, announce: boolean): null {
  if (process.env.NARSIL_REQUIRE_NATIVE_CORE === '1') refuseToSearchWithoutTheCore(reason)
  loaded = null
  if (announce) console.warn(`Narsil searches through WebAssembly on this thread, because ${reason}.`)
  return null
}

function loadedCore(path: string): NativeCore | null {
  const require = createRequire(import.meta.url)
  const core = require(path) as NativeCore
  if (typeof core.abiVersion !== 'function' || core.abiVersion() !== NATIVE_CORE_ABI_VERSION) return null
  return core
}

export function loadNativeCore(): NativeCore | null {
  if (loaded !== undefined) return loaded
  if (requestedBackend() === 'wasm') {
    return reportMissingCore('NARSIL_SEARCH_BACKEND asks for the WebAssembly search', false)
  }
  const named = namedBinaryPath()
  const path = named ?? publishedBinaryPath(createRequire(import.meta.url))
  if (path === null || !existsSync(path)) {
    return reportMissingCore(`this platform has no native search core at ${path ?? 'any known path'}`, true)
  }
  let core: NativeCore | null
  try {
    core = loadedCore(path)
  } catch (error) {
    return reportMissingCore(
      `loading the native search core at ${path} failed with "${error instanceof Error ? error.message : String(error)}"`,
      true,
    )
  }
  if (core === null) {
    return reportMissingCore(`the native search core at ${path} reports another ABI version`, true)
  }
  loaded = core
  return loaded
}
