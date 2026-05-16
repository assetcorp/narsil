import type { EmbeddingAdapter } from '../../types/adapters'
import type { SchemaDefinition } from '../../types/schema'

export function createMockAdapter(
  dimensions: number = 384,
): EmbeddingAdapter & { calls: Array<{ input: string; purpose: string }> } {
  const calls: Array<{ input: string; purpose: string }> = []
  return {
    dimensions,
    calls,
    async embed(input, purpose) {
      calls.push({ input, purpose })
      const vec = new Float32Array(dimensions)
      for (let i = 0; i < dimensions; i++) vec[i] = Math.random()
      return vec
    },
    async embedBatch(inputs, purpose) {
      return inputs.map(input => {
        calls.push({ input, purpose })
        const vec = new Float32Array(dimensions)
        for (let i = 0; i < dimensions; i++) vec[i] = Math.random()
        return vec
      })
    },
  }
}

export function createFailingAdapter(dimensions: number = 384): EmbeddingAdapter {
  return {
    dimensions,
    async embed() {
      throw new Error('Adapter crashed')
    },
  }
}

export function createWrongDimensionAdapter(reportedDimensions: number, actualDimensions: number): EmbeddingAdapter {
  return {
    dimensions: reportedDimensions,
    async embed(_input, _purpose) {
      return new Float32Array(actualDimensions)
    },
  }
}

export const vectorSchema: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  embedding: 'vector[384]' as const,
}

export const vectorSchemaWithCategory: SchemaDefinition = {
  title: 'string' as const,
  body: 'string' as const,
  category: 'enum' as const,
  embedding: 'vector[384]' as const,
}
