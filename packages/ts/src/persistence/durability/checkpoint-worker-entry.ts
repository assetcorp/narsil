import { resolveWorkerEntry } from '../../workers/entry-point'

export function resolveCheckpointWorkerEntry(): string | null {
  return resolveWorkerEntry(
    import.meta.url,
    /\/src\/persistence\/durability\/[^/]+$/,
    'persistence/durability/checkpoint-worker.mjs',
  )
}
