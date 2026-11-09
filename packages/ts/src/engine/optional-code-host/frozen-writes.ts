import { bindFrozenRemovalKernel } from '../../core/frozen-writes/bound-kernel'
import {
  PENDING_DOCUMENTS,
  PENDING_TOKEN_WORDS,
  PENDING_TOKENS,
  PENDING_UNITS,
  pendingSettled,
} from '../../core/frozen-writes/pending'
import { readFrozenRequest, readFrozenSettle } from '../../core/frozen-writes/regions'
import { textAt } from '../../core/frozen-writes/strings'
import { compareBytes } from '../../core/partition/frozen/string-blob'

export function frozenWritesHostPart() {
  return {
    PENDING_DOCUMENTS,
    PENDING_TOKEN_WORDS,
    PENDING_TOKENS,
    PENDING_UNITS,
    bindFrozenRemovalKernel,
    compareBytes,
    pendingSettled,
    readFrozenRequest,
    readFrozenSettle,
    textAt,
  }
}
