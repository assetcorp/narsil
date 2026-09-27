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

interface CoreUnavailable {
  missing: string
}

let loaded: NativeCore | null | undefined

function usesMuslLibc(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    return report.header?.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

function isUnavailable(value: object): value is CoreUnavailable {
  return 'missing' in value
}

function binaryFileSegments(): string[] {
  return process.platform === 'linux' && usesMuslLibc() ? [MUSL_DIRECTORY, BINARY_FILE_NAME] : [BINARY_FILE_NAME]
}

function publishedCoreLocation(target: string): { path: string } | CoreUnavailable {
  const packageName = `@delali/narsil-native-${target}`
  let manifest: string
  try {
    manifest = createRequire(import.meta.url).resolve(`${packageName}/package.json`)
  } catch {
    return { missing: `this installation has no "${packageName}" package` }
  }
  const path = join(dirname(manifest), ...binaryFileSegments())
  if (!existsSync(path)) return { missing: `the "${packageName}" package has no search core at ${path}` }
  return { path }
}

function coreLocation(): { path: string } | CoreUnavailable {
  const named = process.env.NARSIL_NATIVE_CORE_PATH
  if (named !== undefined && named.length > 0) {
    if (!existsSync(named)) {
      return { missing: `this process sets NARSIL_NATIVE_CORE_PATH to ${named}, where no file exists` }
    }
    return { path: named }
  }
  const target = `${process.platform}-${process.arch}`
  if (!PLATFORMS_WITH_A_BINARY.has(target)) {
    return { missing: `the Narsil release includes no search core for ${target}` }
  }
  return publishedCoreLocation(target)
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

function coreAt(path: string): NativeCore | CoreUnavailable {
  let core: NativeCore
  try {
    core = createRequire(import.meta.url)(path) as NativeCore
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { missing: `node raised "${message}" while loading the search core at ${path}` }
  }
  if (typeof core.abiVersion !== 'function') return { missing: `the file at ${path} is no Narsil search core` }
  const reported = core.abiVersion()
  if (reported !== NATIVE_CORE_ABI_VERSION) {
    return {
      missing: `the search core at ${path} reports ABI version ${reported}, while this build of Narsil needs ${NATIVE_CORE_ABI_VERSION}`,
    }
  }
  return core
}

export function requireSearchBackendSettings(): void {
  requestedBackend()
  if (process.env.NARSIL_REQUIRE_NATIVE_CORE === '1') loadNativeCore()
}

export function loadNativeCore(): NativeCore | null {
  if (loaded !== undefined) return loaded
  if (requestedBackend() === 'wasm') {
    return reportMissingCore('this process sets NARSIL_SEARCH_BACKEND to the WebAssembly search', false)
  }
  const location = coreLocation()
  if (isUnavailable(location)) return reportMissingCore(location.missing, true)
  const core = coreAt(location.path)
  if (isUnavailable(core)) return reportMissingCore(core.missing, true)
  loaded = core
  return loaded
}
