import { MAX_DOC_ID_LENGTH } from '../../../engine/constants'
import { validateIndexName } from '../../cluster/index-metadata'
import type { FetchPayload, FetchResultPayload } from '../../transport/types'
import { MAX_FETCH_DOCUMENT_IDS, MAX_FIELDS_LIST, MAX_SEARCH_CONTEXT_ID_LENGTH } from '../constants'
import {
  CONFIG_INVALID,
  isRecord,
  SEARCH_INVALID_FIELD,
  throwInvalid,
  validatePartitionId,
  validateStringArray,
  validateStringField,
} from './common'

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
  decoded.fields ??= null
  decoded.highlight = null
  if (decoded.fields !== null) {
    validateStringArray(decoded.fields, 'fields', MAX_FIELDS_LIST, 255, SEARCH_INVALID_FIELD)
  }
  if (decoded.vectors !== null && decoded.vectors !== undefined && typeof decoded.vectors !== 'boolean') {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchPayload: "vectors" must be a boolean, or null')
  }
  if (decoded.contextId !== null && decoded.contextId !== undefined) {
    validateStringField(decoded.contextId, 'contextId', MAX_SEARCH_CONTEXT_ID_LENGTH, CONFIG_INVALID)
  }
  if (
    decoded.releaseContext !== null &&
    decoded.releaseContext !== undefined &&
    typeof decoded.releaseContext !== 'boolean'
  ) {
    throwInvalid(CONFIG_INVALID, 'Invalid FetchPayload: "releaseContext" must be a boolean, or null')
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
    doc.highlights = null
  }
  return decoded as unknown as FetchResultPayload
}
