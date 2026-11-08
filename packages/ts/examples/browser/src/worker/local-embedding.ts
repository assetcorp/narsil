import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'
import { PLACES_EMBEDDING_DIMENSIONS, PLACES_EMBEDDING_DTYPE, PLACES_EMBEDDING_MODEL } from './local-models.ts'

export type PlacesEmbedding = ReturnType<typeof createTransformersEmbedding>

export function createPlacesEmbedding(): PlacesEmbedding {
  return createTransformersEmbedding({
    model: PLACES_EMBEDDING_MODEL,
    dimensions: PLACES_EMBEDDING_DIMENSIONS,
    dtype: PLACES_EMBEDDING_DTYPE,
  })
}
