import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { httpStatusForNarsilError } from '../../server/errors'

describe('httpStatusForNarsilError', () => {
  it('maps every replication and partition-routing code to 503', () => {
    const codes = [
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
      ErrorCodes.REPLICATION_ROLLBACK_FAILED,
      ErrorCodes.REPLICATION_LOG_FULL,
      ErrorCodes.REPLICATION_ENTRY_CORRUPT,
      ErrorCodes.REPLICATION_SNAPSHOT_CORRUPT,
      ErrorCodes.REPLICATION_TERM_MISMATCH,
      ErrorCodes.REPLICATION_SYNC_FAILED,
      ErrorCodes.PARTITION_NOT_PRIMARY,
      ErrorCodes.PARTITION_UNASSIGNED,
      ErrorCodes.INSUFFICIENT_REPLICAS,
    ]
    for (const code of codes) {
      expect(httpStatusForNarsilError(code)).toBe(503)
    }
  })

  it('answers 500 for a code outside the map', () => {
    expect(httpStatusForNarsilError('SOMETHING_UNKNOWN')).toBe(500)
  })
})
