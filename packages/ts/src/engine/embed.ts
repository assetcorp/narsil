import { type ErrorCode, ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'
import type { EmbeddingFieldConfig } from '../types/schema'

export interface BatchEmbedResult {
  embedded: Map<number, Set<string>>
  failed: Map<number, NarsilError>
}

function validateVector(vector: unknown, targetField: string, expectedDimensions: number): Float32Array {
  if (!(vector instanceof Float32Array)) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_FAILED,
      `Adapter returned ${typeof vector} for field "${targetField}", expected Float32Array`,
      { field: targetField, returnedType: typeof vector },
    )
  }
  if (vector.length !== expectedDimensions) {
    throw new NarsilError(
      ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
      `Adapter returned ${vector.length}-dimensional vector for field "${targetField}", expected ${expectedDimensions}`,
      { field: targetField, expected: expectedDimensions, actual: vector.length },
    )
  }
  for (let i = 0; i < vector.length; i++) {
    if (Number.isNaN(vector[i])) {
      throw new NarsilError(
        ErrorCodes.EMBEDDING_FAILED,
        `Adapter returned vector with NaN at index ${i} for field "${targetField}"`,
        { field: targetField, index: i },
      )
    }
  }
  return vector
}

function resolveFieldValue(document: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return document[path]
  const segments = path.split('.')
  let current: unknown = document
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function setFieldValue(document: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes('.')) {
    document[path] = value
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = document
  for (let i = 0; i < segments.length - 1; i++) {
    let next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') {
      next = {}
      current[segments[i]] = next
    }
    current = next as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}

function deleteFieldValue(document: Record<string, unknown>, path: string): void {
  if (!path.includes('.')) {
    delete document[path]
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = document
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]]
}

function collectSourceText(
  document: Record<string, unknown>,
  sourceFields: string | string[],
  targetField: string,
  documentIndex?: number,
): string {
  const sources = Array.isArray(sourceFields) ? sourceFields : [sourceFields]
  const parts: string[] = []

  for (const source of sources) {
    const value = resolveFieldValue(document, source)
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') {
      throw new NarsilError(
        ErrorCodes.DOC_VALIDATION_FAILED,
        `Embedding source field "${source}" must be a string, got ${typeof value}`,
        { field: source, targetField },
      )
    }
    parts.push(value)
  }

  if (parts.length === 0) {
    const details: Record<string, unknown> = { field: targetField }
    if (documentIndex !== undefined) {
      details.documentIndex = documentIndex
    }
    throw new NarsilError(
      ErrorCodes.EMBEDDING_NO_SOURCE,
      `All source fields for embedding target "${targetField}" are missing or empty`,
      details,
    )
  }

  return parts.join('\n')
}

function wrapAdapterError(err: unknown, targetField: string): NarsilError {
  if (err instanceof NarsilError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new NarsilError(ErrorCodes.EMBEDDING_FAILED, `Embedding failed for field "${targetField}": ${message}`, {
    field: targetField,
    cause: message,
  })
}

export async function embedDocumentFields(
  document: Record<string, unknown>,
  embeddingConfig: EmbeddingFieldConfig,
  adapter: EmbeddingAdapter,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const embeddedFields = new Set<string>()

  try {
    for (const [targetField, sourceFields] of Object.entries(embeddingConfig.fields)) {
      const existing = resolveFieldValue(document, targetField)
      if (existing !== undefined && existing !== null) continue

      const text = collectSourceText(document, sourceFields, targetField)

      let vector: Float32Array
      try {
        const raw = await adapter.embed(text, 'document', signal)
        vector = validateVector(raw, targetField, adapter.dimensions)
      } catch (err) {
        throw wrapAdapterError(err, targetField)
      }

      setFieldValue(document, targetField, vector)
      embeddedFields.add(targetField)
    }
  } catch (err) {
    for (const field of embeddedFields) {
      deleteFieldValue(document, field)
    }
    throw err
  }

  return embeddedFields
}

const SOURCE_FAILURE_CODES = new Set<ErrorCode>([ErrorCodes.EMBEDDING_NO_SOURCE, ErrorCodes.DOC_VALIDATION_FAILED])

function isDocumentSourceError(err: unknown): err is NarsilError {
  return err instanceof NarsilError && SOURCE_FAILURE_CODES.has(err.code)
}

export async function embedBatchDocumentFields(
  documents: Record<string, unknown>[],
  embeddingConfig: EmbeddingFieldConfig,
  adapter: EmbeddingAdapter,
  signal?: AbortSignal,
): Promise<BatchEmbedResult> {
  const embedded = new Map<number, Set<string>>()
  const failed = new Map<number, NarsilError>()

  try {
    for (const [targetField, sourceFields] of Object.entries(embeddingConfig.fields)) {
      const needsEmbedding: Array<{ docIndex: number; text: string }> = []

      for (let i = 0; i < documents.length; i++) {
        if (failed.has(i)) continue

        const doc = documents[i]
        const existing = resolveFieldValue(doc, targetField)
        if (existing !== undefined && existing !== null) continue

        try {
          const text = collectSourceText(doc, sourceFields, targetField, i)
          needsEmbedding.push({ docIndex: i, text })
        } catch (err) {
          if (isDocumentSourceError(err)) {
            failed.set(i, err)
          } else {
            throw err
          }
        }
      }

      if (needsEmbedding.length === 0) continue

      const texts = needsEmbedding.map(entry => entry.text)
      let vectors: Float32Array[]

      try {
        if (adapter.embedBatch) {
          vectors = await adapter.embedBatch(texts, 'document', signal)
        } else {
          vectors = []
          const concurrency = 8
          for (let start = 0; start < texts.length; start += concurrency) {
            const chunk = texts.slice(start, start + concurrency)
            const chunkResults = await Promise.all(chunk.map(t => adapter.embed(t, 'document', signal)))
            vectors.push(...chunkResults)
          }
        }
      } catch (err) {
        throw wrapAdapterError(err, targetField)
      }

      if (vectors.length !== needsEmbedding.length) {
        throw new NarsilError(
          ErrorCodes.EMBEDDING_FAILED,
          `Adapter returned ${vectors.length} vectors for ${needsEmbedding.length} inputs on field "${targetField}"`,
          { field: targetField, expected: needsEmbedding.length, actual: vectors.length },
        )
      }

      for (let j = 0; j < needsEmbedding.length; j++) {
        const { docIndex } = needsEmbedding[j]
        const validated = validateVector(vectors[j], targetField, adapter.dimensions)
        setFieldValue(documents[docIndex], targetField, validated)

        let fieldSet = embedded.get(docIndex)
        if (!fieldSet) {
          fieldSet = new Set<string>()
          embedded.set(docIndex, fieldSet)
        }
        fieldSet.add(targetField)
      }
    }
  } catch (err) {
    for (const [docIndex, fields] of embedded) {
      for (const field of fields) {
        deleteFieldValue(documents[docIndex], field)
      }
    }
    throw err
  }

  return { embedded, failed }
}
