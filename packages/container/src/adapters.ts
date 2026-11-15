import type { EmbeddingAdapter, RerankAdapter } from '@delali/narsil'
import { createOpenAIEmbedding } from '@delali/narsil/embeddings/openai'
import { createHttpReranker } from '@delali/narsil/rerankers/http'
import type { EmbedderSetting, RerankerSetting } from './settings/types'

export interface BuiltAdapters {
  embeddingAdapters: Record<string, EmbeddingAdapter>
  rerankAdapters: Record<string, RerankAdapter>
}

async function embedderOf(setting: EmbedderSetting, modelsDir: string): Promise<EmbeddingAdapter> {
  if (setting.kind === 'openai') {
    return createOpenAIEmbedding({
      baseUrl: setting.url ?? '',
      model: setting.model,
      dimensions: setting.dimensions,
      timeout: setting.timeoutMs,
      maxRetries: setting.maxRetries,
      ...(setting.apiKey === undefined ? {} : { apiKey: setting.apiKey }),
    })
  }
  const { createTransformersEmbedding } = await import('@delali/narsil-embeddings-transformers')
  return createTransformersEmbedding({ model: setting.model, dimensions: setting.dimensions, cacheDir: modelsDir })
}

async function rerankerOf(setting: RerankerSetting, modelsDir: string): Promise<RerankAdapter> {
  if (setting.kind === 'http') {
    return createHttpReranker({
      baseUrl: setting.url ?? '',
      model: setting.model,
      timeout: setting.timeoutMs,
      maxRetries: setting.maxRetries,
      maxDocumentsPerRequest: setting.maxDocumentsPerRequest,
      ...(setting.apiKey === undefined ? {} : { apiKey: setting.apiKey }),
    })
  }
  const { createTransformersReranker } = await import('@delali/narsil-embeddings-transformers/reranker')
  return createTransformersReranker({ model: setting.model, cacheDir: modelsDir })
}

export async function buildAdapters(
  embedders: readonly EmbedderSetting[],
  rerankers: readonly RerankerSetting[],
  modelsDir: string,
): Promise<BuiltAdapters> {
  const embeddingAdapters: Record<string, EmbeddingAdapter> = {}
  const rerankAdapters: Record<string, RerankAdapter> = {}
  for (const setting of embedders) embeddingAdapters[setting.name] = await embedderOf(setting, modelsDir)
  for (const setting of rerankers) rerankAdapters[setting.name] = await rerankerOf(setting, modelsDir)
  return { embeddingAdapters, rerankAdapters }
}
