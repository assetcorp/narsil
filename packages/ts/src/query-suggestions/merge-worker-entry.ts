import { resolveWorkerEntry } from '../workers/entry-point'

export function resolveMergeWorkerEntry(): string | null {
  return resolveWorkerEntry(import.meta.url, /\/src\/query-suggestions\/[^/]+$/, 'query-suggestions/merge-worker.mjs')
}
