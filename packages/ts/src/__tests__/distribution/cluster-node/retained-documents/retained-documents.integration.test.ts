import { describe, it } from 'vitest'
import { CHILD_RUNS, CHILD_TIMEOUT_MS, expectLogsKeepAtMostOneJsonCopyPerDocument } from './harness'

const SINGLE_INSERTS = 2_000
const BATCHES = 16

describe('the replication logs on a primary and its replica', () => {
  it(
    'keep no more buffer bytes per document than its JSON takes, once per copy',
    () => expectLogsKeepAtMostOneJsonCopyPerDocument(SINGLE_INSERTS, BATCHES),
    CHILD_RUNS * CHILD_TIMEOUT_MS,
  )
})
