import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

export type SearchBackend = 'native' | 'wasm'

const hostCore =
  process.env.NARSIL_NATIVE_CORE_PATH ??
  fileURLToPath(
    new URL(`../../../../../native/npm/${process.platform}-${process.arch}/narsil-core.node`, import.meta.url),
  )

export const BACKEND_NAMES: Record<SearchBackend, string> = {
  native: 'the C search',
  wasm: 'the WebAssembly search',
}

export function backendAvailable(backend: SearchBackend): boolean {
  return backend === 'wasm' || existsSync(hostCore)
}

const SETTINGS = ['NARSIL_SEARCH_BACKEND', 'NARSIL_NATIVE_CORE_PATH', 'NARSIL_REQUIRE_NATIVE_CORE'] as const

export function searchThrough(backend: SearchBackend): void {
  const previous = new Map(SETTINGS.map(name => [name, process.env[name]]))
  process.env.NARSIL_SEARCH_BACKEND = backend
  if (backend === 'native') {
    process.env.NARSIL_NATIVE_CORE_PATH = hostCore
    process.env.NARSIL_REQUIRE_NATIVE_CORE = '1'
  } else {
    delete process.env.NARSIL_REQUIRE_NATIVE_CORE
  }
  afterAll(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}
