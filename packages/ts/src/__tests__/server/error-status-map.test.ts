import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { httpStatusForNarsilError, ServerErrorCodes } from '../../server/errors'

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

  it('maps every code the HTTP layer raises', () => {
    const expected: Record<string, number> = {
      INVALID_REQUEST: 400,
      INVALID_JSON: 400,
      EMPTY_BODY: 400,
      PAYLOAD_TOO_LARGE: 413,
      NOT_FOUND: 404,
      TASK_NOT_FOUND: 404,
      TASK_NOT_CANCELLABLE: 409,
      TASK_OWNED_BY_ANOTHER_INSTANCE: 409,
      TOO_MANY_REQUESTS: 429,
      HOOK_ERROR: 500,
      INTERNAL_ERROR: 500,
    }
    for (const code of Object.values(ServerErrorCodes)) {
      expect(httpStatusForNarsilError(code)).toBe(expected[code])
    }
  })

  it('treats a malformed narsil file as a client failure', () => {
    expect(httpStatusForNarsilError(ErrorCodes.ENVELOPE_INVALID_MAGIC)).toBe(400)
    expect(httpStatusForNarsilError(ErrorCodes.ENVELOPE_VERSION_MISMATCH)).toBe(400)
  })
})
