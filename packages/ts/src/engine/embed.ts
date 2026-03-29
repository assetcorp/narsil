import { ErrorCodes, NarsilError } from '../errors'
import type { EmbeddingAdapter } from '../types/adapters'
import type { EmbeddingFieldConfig } from '../types/schema'

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
  return vector
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
    const value = document[source]
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
      const existing = document[targetField]
      if (existing !== undefined && existing !== null) continue

      const text = collectSourceText(document, sourceFields, targetField)

      let vector: Float32Array
      try {
        const raw = await adapter.embed(text, 'document', signal)
        vector = validateVector(raw, targetField, adapter.dimensions)
      } catch (err) {
        throw wrapAdapterError(err, targetField)
      }

      document[targetField] = vector
      embeddedFields.add(targetField)
    }
  } catch (err) {
    for (const field of embeddedFields) {
      delete document[field]
    }
    throw err
  }

  return embeddedFields
}

export async function embedBatchDocumentFields(
  documents: Record<string, unknown>[],
  embeddingConfig: EmbeddingFieldConfig,
  adapter: EmbeddingAdapter,
  signal?: AbortSignal,
): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>()

  try {
    for (const [targetField, sourceFields] of Object.entries(embeddingConfig.fields)) {
      const needsEmbedding: Array<{ docIndex: number; text: string }> = []

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i]
        const existing = doc[targetField]
        if (existing !== undefined && existing !== null) continue

        const text = collectSourceText(doc, sourceFields, targetField, i)
        needsEmbedding.push({ docIndex: i, text })
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
        documents[docIndex][targetField] = validated

        let fieldSet = result.get(docIndex)
        if (!fieldSet) {
          fieldSet = new Set<string>()
          result.set(docIndex, fieldSet)
        }
        fieldSet.add(targetField)
      }
    }
  } catch (err) {
    for (const [docIndex, fields] of result) {
      for (const field of fields) {
        delete documents[docIndex][field]
      }
    }
    throw err
  }

  return result
}
