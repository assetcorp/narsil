import type { AnyDocument } from '@delali/narsil'
import type { HttpIndexConfig } from '@delali/narsil/client'
import type { DatasetId, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { scifact, tmdb, wikipedia } from '@delali/narsil-example-shared/manifest'
import { scifactSchema, tmdbSchema, wikipediaSchema } from '@delali/narsil-example-shared/schemas'
import { createServerFn } from '@tanstack/react-start'

const DATASET_IDS = new Set<string>(['tmdb', 'wikipedia', 'scifact', 'custom'])

function parseLoadRequest(input: unknown): LoadDatasetRequest {
  const request = input as LoadDatasetRequest
  if (typeof request !== 'object' || request === null || !DATASET_IDS.has(request.datasetId)) {
    throw new Error('The request must name a dataset this app knows')
  }
  return request
}

interface IndexPlan {
  indexName: string
  datasetId: DatasetId
  schema: Record<string, unknown>
  language: string
  file: { directory: string; name: string }
}

function plansFor(request: LoadDatasetRequest): IndexPlan[] {
  switch (request.datasetId) {
    case 'tmdb': {
      const tier = tmdb.tiers.find(entry => entry.label === request.tier)
      if (!tier) throw new Error(`The TMDB tier "${request.tier}" is not in the manifest`)
      return [
        {
          indexName: `tmdb-${request.tier}`,
          datasetId: 'tmdb',
          schema: tmdbSchema as Record<string, unknown>,
          language: 'english',
          file: { directory: 'tmdb', name: tier.file },
        },
      ]
    }
    case 'wikipedia':
      return request.languages.flatMap(code => {
        const language = wikipedia.languages.find(entry => entry.code === code)
        if (!language) return []
        return [
          {
            indexName: `wikipedia-${code}`,
            datasetId: 'wikipedia' as const,
            schema: wikipediaSchema as Record<string, unknown>,
            language: code,
            file: { directory: 'wikipedia', name: language.file },
          },
        ]
      })
    case 'scifact':
      return [
        {
          indexName: 'scifact',
          datasetId: 'scifact',
          schema: scifactSchema as Record<string, unknown>,
          language: 'english',
          file: { directory: 'scifact', name: scifact.docsFile },
        },
      ]
    case 'custom':
      throw new Error('A custom dataset is loaded from the browser, which already holds its documents')
  }
}

/**
 * Creates each index the request names and hands its corpus to the search
 * server as an import task. The task runs there, so it survives this page,
 * and the browser follows it through the task API.
 */
export const startDatasetLoadFn = createServerFn({ method: 'POST' })
  .inputValidator(parseLoadRequest)
  .handler(async ({ data }) => {
    const [
      { getNarsilClient },
      { findDataRoot, readDocumentsFile },
      { readEmbeddingConfig, EMBEDDING_ADAPTER_NAME, EMBEDDING_FIELD },
    ] = await Promise.all([import('./narsil/server-client'), import('./dataset-files'), import('./embedding-config')])
    const [{ dedupeDocumentsById, languageName, planEmbedding }, client] = await Promise.all([
      import('./dataset-plan'),
      getNarsilClient(),
    ])

    const dataRoot = findDataRoot()
    const embedding = readEmbeddingConfig()
    const existing = await client.listIndexes()
    const taskIds: string[] = []

    for (const plan of plansFor(data)) {
      if (existing.some(index => index.name === plan.indexName)) continue

      const documents = dedupeDocumentsById(await readDocumentsFile(dataRoot, plan.file.directory, plan.file.name))
      const planned = planEmbedding(
        {
          indexName: plan.indexName,
          datasetId: plan.datasetId,
          schema: plan.schema,
          language: plan.datasetId === 'wikipedia' ? languageName(plan.language) : plan.language,
          docs: documents,
        },
        embedding,
      )

      const config: HttpIndexConfig = { schema: planned.schema, language: planned.language }
      if (planned.embedding) {
        config.embedding = {
          fields: { [EMBEDDING_FIELD]: planned.embedding.sourceFields },
          adapter: EMBEDDING_ADAPTER_NAME,
        }
      }

      await client.createIndex(plan.indexName, config)
      try {
        const task = await client.startImport(plan.indexName, planned.docs as AnyDocument[])
        taskIds.push(task.id)
      } catch (err) {
        await client.dropIndex(plan.indexName).catch(() => undefined)
        throw err
      }
    }

    return { taskIds }
  })
