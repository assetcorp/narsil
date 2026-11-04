import { resolveWorkerEntry } from '../../workers/entry-point'

export function resolveWorkerEntryPoint(): string | null {
  return resolveWorkerEntry(import.meta.url, /\/src\/vector\/search-pool\/[^/]+$/, 'vector/search-worker.mjs')
}
