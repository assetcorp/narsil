import { archiveJson, documentExportJson } from './archive-kinds'
import type { FormContext } from './codec'
import { FormError } from './decoded'
import { keywordSegmentJson, manifestJson, mirroredMapJson } from './envelope-kinds'
import { type ContentRules, contentDifference, type Json, type JsonObject } from './json'
import { commitMarkerJson, logSegmentJson } from './log-kinds'
import { pagedSegmentJson } from './paged-segment'
import { graphPartJson, type VectorStorage, vectorFileJson } from './vector-kinds'

export const SAMPLE_KINDS = [
  'log-segment',
  'commit-marker',
  'manifest',
  'keyword-segment',
  'paged-segment',
  'vector-file',
  'graph-part',
  'index-metadata',
  'index-configuration',
  'backup-manifest',
  'snapshot-archive',
  'document-export',
] as const

export type SampleKind = (typeof SAMPLE_KINDS)[number]

export function isSampleKind(value: unknown): value is SampleKind {
  return SAMPLE_KINDS.some(kind => kind === value)
}

export interface FormRequest {
  kind: SampleKind
  bytes: Uint8Array
  storage?: VectorStorage
  what: string
}

function storageOf(request: FormRequest): VectorStorage {
  if (request.storage === undefined) throw new FormError(`${request.what} is a ${request.kind} with no storage`)
  return request.storage
}

export async function formOf(request: FormRequest, context: FormContext): Promise<JsonObject> {
  const { kind, bytes, what } = request
  switch (kind) {
    case 'log-segment':
      return logSegmentJson(bytes, context, what)
    case 'commit-marker':
      return commitMarkerJson(bytes, context, what)
    case 'manifest':
      return manifestJson(bytes, context, what, false)
    case 'keyword-segment':
      return keywordSegmentJson(bytes, context, what)
    case 'paged-segment': {
      const { header, payload } = await context.openEnvelope(bytes, what)
      return pagedSegmentJson(header, payload, context, what)
    }
    case 'vector-file':
      return vectorFileJson(bytes, storageOf(request), context, what)
    case 'graph-part':
      return graphPartJson(bytes, storageOf(request), context, what)
    case 'index-metadata':
    case 'index-configuration':
    case 'backup-manifest':
      return mirroredMapJson(bytes, context, what)
    case 'snapshot-archive':
      return archiveJson(bytes, context, what)
    case 'document-export':
      return documentExportJson(bytes, what)
  }
}

export function contentRulesOf(kind: SampleKind): ContentRules {
  return { signedZero: kind === 'document-export' }
}

export function formDifference(kind: SampleKind, expected: Json, actual: Json): string | null {
  return contentDifference(expected, actual, '', contentRulesOf(kind))
}
