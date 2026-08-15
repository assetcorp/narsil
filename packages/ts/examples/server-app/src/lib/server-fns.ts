import { createServerFn } from '@tanstack/react-start'
import { parseThreadIdInput } from './chat/validation'

export const askCapabilitiesFn = createServerFn({ method: 'POST' }).handler(async () => {
  const [{ readLlmConfig }, { readEmbeddingConfig }] = await Promise.all([
    import('./ask/config'),
    import('./embedding-config'),
  ])
  const llm = readLlmConfig()
  const embeddings = readEmbeddingConfig()
  return {
    llmConfigured: llm !== null,
    llmModel: llm?.model ?? null,
    embeddingsConfigured: embeddings !== null,
    embeddingModel: embeddings?.model ?? null,
    embeddingDimensions: embeddings?.dimensions ?? null,
  }
})

export const listThreadsFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { listThreads } = await import('./chat/store')
  return listThreads()
})

export const loadThreadFn = createServerFn({ method: 'POST' })
  .inputValidator(parseThreadIdInput)
  .handler(async ({ data }) => {
    const { loadThreadSerialized } = await import('./chat/store')
    return loadThreadSerialized(data.id)
  })

export const deleteThreadFn = createServerFn({ method: 'POST' })
  .inputValidator(parseThreadIdInput)
  .handler(async ({ data }) => {
    const { deleteThread } = await import('./chat/store')
    await deleteThread(data.id)
  })
