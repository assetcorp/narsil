import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const INSERT_DOCUMENTS = fileURLToPath(new URL('./insert-documents.mjs', import.meta.url))
const COPIES_PER_DOCUMENT = 2
const NEARLY_EMPTY_LOG_RETENTION_BYTES = 4_096
const CHILD_TIMEOUT_MS = 120_000
const CHILD_RUNS = 2

interface RetainedBytes {
  documents: number
  arrayBufferBytesPerDocument: number
  jsonBytesPerDocument: number
}

function insertDocuments(args: string[]): RetainedBytes {
  const finished = spawnSync(process.execPath, ['--expose-gc', INSERT_DOCUMENTS, ...args], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  })
  expect(finished.status, finished.stderr).toBe(0)
  const line = finished.stdout.split('\n').find(entry => entry.startsWith('{'))
  if (line === undefined) throw new Error(`the child printed no figures: ${finished.stdout}${finished.stderr}`)
  return JSON.parse(line) as RetainedBytes
}

describe('the replication logs on a primary and its replica', () => {
  it(
    'keep no more buffer bytes per document than its JSON takes, once per copy',
    () => {
      const withoutLog = insertDocuments([String(NEARLY_EMPTY_LOG_RETENTION_BYTES)])
      const withLog = insertDocuments([])
      const logBytesPerDocument = withLog.arrayBufferBytesPerDocument - withoutLog.arrayBufferBytesPerDocument

      expect(withLog.documents).toBe(10_000)
      expect(logBytesPerDocument).toBeGreaterThan(0)
      expect(logBytesPerDocument).toBeLessThanOrEqual(COPIES_PER_DOCUMENT * withLog.jsonBytesPerDocument)
    },
    CHILD_RUNS * CHILD_TIMEOUT_MS,
  )
})
