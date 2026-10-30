import { describe, it } from 'vitest'
import { CHILD_RUNS, CHILD_TIMEOUT_MS, expectLogsKeepAtMostOneJsonCopyPerDocument } from './harness'

const SINGLE_INSERTS = 500
const BATCHES = 3

describe('the replication logs after two thousand documents', () => {
  it(
    'keep no more buffer bytes per document than its JSON takes, once per copy',
    () => expectLogsKeepAtMostOneJsonCopyPerDocument(SINGLE_INSERTS, BATCHES),
    CHILD_RUNS * CHILD_TIMEOUT_MS,
  )
})
