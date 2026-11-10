import { resolveWorkerEntry } from '#platform/storage-host'

export function resolveCheckpointWorkerEntry(): string | null {
  return resolveWorkerEntry(
    import.meta.url,
    /\/src\/persistence\/durability\/[^/]+$/,
    'persistence/durability/checkpoint-worker.mjs',
  )
}
