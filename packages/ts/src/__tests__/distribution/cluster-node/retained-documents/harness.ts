import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const INSERT_DOCUMENTS = fileURLToPath(new URL('./insert-documents.mjs', import.meta.url))
const COPIES_PER_DOCUMENT = 2
const NEARLY_EMPTY_LOG_RETENTION_BYTES = 4_096
const BATCH_SIZE = 500
export const CHILD_TIMEOUT_MS = 120_000
export const CHILD_RUNS = 2

interface RetainedBytes {
  documents: number
  arrayBufferBytesPerDocument: number
  jsonBytesPerDocument: number
}

function insertDocuments(args: number[]): RetainedBytes {
  const finished = spawnSync(process.execPath, ['--expose-gc', INSERT_DOCUMENTS, ...args.map(String)], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  })
  expect(finished.status, finished.stderr).toBe(0)
  const line = finished.stdout.split('\n').find(entry => entry.startsWith('{'))
  if (line === undefined) throw new Error(`the child printed no figures: ${finished.stdout}${finished.stderr}`)
  return JSON.parse(line) as RetainedBytes
}

export function expectLogsKeepAtMostOneJsonCopyPerDocument(singleInserts: number, batches: number): void {
  const withoutLog = insertDocuments([singleInserts, batches, NEARLY_EMPTY_LOG_RETENTION_BYTES])
  const withLog = insertDocuments([singleInserts, batches])
  const logBytesPerDocument = withLog.arrayBufferBytesPerDocument - withoutLog.arrayBufferBytesPerDocument

  expect(withLog.documents).toBe(singleInserts + batches * BATCH_SIZE)
  expect(logBytesPerDocument).toBeGreaterThan(0)
  expect(logBytesPerDocument).toBeLessThanOrEqual(COPIES_PER_DOCUMENT * withLog.jsonBytesPerDocument)
}
