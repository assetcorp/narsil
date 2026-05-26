import { validateIndexName } from '../../cluster/index-metadata'
import type { FetchPayload, FetchResultPayload } from '../../transport/types'
import {
  CONFIG_INVALID,
  isRecord,
  MAX_DOC_ID_LENGTH,
  MAX_FETCH_DOCUMENT_IDS,
  MAX_FIELDS_LIST,
  SEARCH_INVALID_FIELD,
  throwInvalid,
  validatePartitionId,
  validateStringArray,
  validateStringField,
} from './common'

const MAX_HIGHLIGHT_TAG_LENGTH = 256
const MAX_HIGHLIGHT_SNIPPET_LENGTH = 65_536

function validateIndexNameField(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throwInvalid(CONFIG_INVALID, `Invalid FetchPayload: "${fieldLabel}" must be a string`)
  }
  validateIndexName(value)
  return value
}

function validateDocumentId(value: unknown, fieldLabel: string): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, `Invalid FetchPayload: "${fieldLabel}" must be an object`)
  }
  validateStringField(value.docId, `${fieldLabel}.docId`, MAX_DOC_ID_LENGTH, CONFIG_INVALID)
  validatePartitionId(value.partitionId, `${fieldLabel}.partitionId`, CONFIG_INVALID)
}

function validateHighlightConfig(value: unknown): void {
  if (!isRecord(value)) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchPayload: "highlight" must be an object or null')
  }
  if (value.fields !== null) {
    validateStringArray(value.fields, 'highlight.fields', MAX_FIELDS_LIST, 255, SEARCH_INVALID_FIELD)
  }
  if (typeof value.before !== 'string' || value.before.length > MAX_HIGHLIGHT_TAG_LENGTH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid FetchPayload: "highlight.before" must be a string of at most ${MAX_HIGHLIGHT_TAG_LENGTH} characters`,
    )
  }
  if (typeof value.after !== 'string' || value.after.length > MAX_HIGHLIGHT_TAG_LENGTH) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid FetchPayload: "highlight.after" must be a string of at most ${MAX_HIGHLIGHT_TAG_LENGTH} characters`,
    )
  }
  if (
    typeof value.maxSnippetLength !== 'number' ||
    !Number.isFinite(value.maxSnippetLength) ||
    !Number.isInteger(value.maxSnippetLength) ||
    value.maxSnippetLength <= 0 ||
    value.maxSnippetLength > MAX_HIGHLIGHT_SNIPPET_LENGTH
  ) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid FetchPayload: "highlight.maxSnippetLength" must be a positive integer at most ${MAX_HIGHLIGHT_SNIPPET_LENGTH}`,
    )
  }
}

export function validateFetchPayload(decoded: unknown): FetchPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchPayload: expected an object')
  }
  validateIndexNameField(decoded.indexName, 'indexName')
  if (!Array.isArray(decoded.documentIds)) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchPayload: "documentIds" must be an array')
  }
  if (decoded.documentIds.length > MAX_FETCH_DOCUMENT_IDS) {
    throwInvalid(
      CONFIG_INVALID,
      `Invalid FetchPayload: "documentIds" exceeds maximum length of ${MAX_FETCH_DOCUMENT_IDS}`,
      { length: decoded.documentIds.length, limit: MAX_FETCH_DOCUMENT_IDS },
    )
  }
  for (let i = 0; i < decoded.documentIds.length; i++) {
    validateDocumentId(decoded.documentIds[i], `documentIds[${i}]`)
  }
  if (decoded.fields !== null) {
    validateStringArray(decoded.fields, 'fields', MAX_FIELDS_LIST, 255, SEARCH_INVALID_FIELD)
  }
  if (decoded.highlight !== null) {
    validateHighlightConfig(decoded.highlight)
  }
  return decoded as unknown as FetchPayload
}

export function validateFetchResultPayload(decoded: unknown): FetchResultPayload {
  if (!isRecord(decoded)) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.documents)) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchResultPayload: "documents" must be an array')
  }
  for (let i = 0; i < decoded.documents.length; i++) {
    const doc = decoded.documents[i]
    if (!isRecord(doc)) {
      throwInvalid(CONFIG_INVALID, `Invalid FetchResultPayload: "documents[${i}]" must be an object`)
    }
    validateStringField(doc.docId, `documents[${i}].docId`, MAX_DOC_ID_LENGTH, CONFIG_INVALID)
    if (!isRecord(doc.document)) {
      throwInvalid(CONFIG_INVALID, `Invalid FetchResultPayload: "documents[${i}].document" must be an object`)
    }
    if (doc.highlights !== null && !isRecord(doc.highlights)) {
      throwInvalid(CONFIG_INVALID, `Invalid FetchResultPayload: "documents[${i}].highlights" must be an object or null`)
    }
  }
  return decoded as unknown as FetchResultPayload
}
