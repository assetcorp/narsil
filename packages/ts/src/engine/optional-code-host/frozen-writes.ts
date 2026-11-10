import { bindFrozenRemovalKernel } from '../../core/frozen-writes/bound-kernel'
import {
  PENDING_DOCUMENTS,
  PENDING_TOKEN_WORDS,
  PENDING_TOKENS,
  PENDING_UNITS,
  pendingSettled,
} from '../../core/frozen-writes/pending'
import { readFrozenParts } from '../../core/frozen-writes/regions'
import { textAt } from '../../core/frozen-writes/strings'
import { compareBytes } from '../../core/partition/frozen/string-blob'
import { visitDocumentSurfaceSpellings } from '../../core/partition/partial-words/spellings'
import { packedTokens } from '../../core/segment-writes/prepared-tokens'
import { transformToken } from '../../core/tokenizer/cache'
import { resolveStopWords } from '../../core/tokenizer/tokenize'

export function frozenWritesHostPart() {
  return {
    PENDING_DOCUMENTS,
    PENDING_TOKEN_WORDS,
    PENDING_TOKENS,
    PENDING_UNITS,
    bindFrozenRemovalKernel,
    compareBytes,
    packedTokens,
    pendingSettled,
    readFrozenParts,
    resolveStopWords,
    textAt,
    transformToken,
    visitDocumentSurfaceSpellings,
  }
}
