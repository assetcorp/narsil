import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import {
  getClusterIndexConfig,
  getIndexMetadata,
  type IndexMetadata,
  indexConfigKey,
  putIndexMetadata,
} from '../../../distribution/cluster/index-metadata'
import { indexSettingsOf } from '../../../distribution/cluster/index-settings'
import { routeCreateIndex } from '../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import { ErrorCodes } from '../../../errors'
import type { EmbeddingAdapter } from '../../../types/adapters'
import type { IndexConfig, SchemaDefinition } from '../../../types/schema'

const INDEX_NAME = 'catalogue'
const SCHEMA: SchemaDefinition = { title: 'string', sku: 'verbatim', embedding: 'vector[3]' }

function metadataWith(settings: IndexMetadata['settings']): IndexMetadata {
  return {
    indexUuid: 'catalogue-uuid',
    indexName: INDEX_NAME,
    partitionCount: 2,
    replicationFactor: 1,
    constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
    ...(settings !== undefined ? { settings } : {}),
  }
}

describe('the settings in cluster index metadata', () => {
  it('give every node the configuration that the creating node received', async () => {
    const coordinator = createInMemoryCoordinator()
    const requested: IndexConfig = {
      schema: SCHEMA,
      tokenizer: 'catalogue-tokenizer',
      stopWords: new Set(['the', 'and', 'a']),
      bm25: { k1: 1.4 },
      surfaceForms: false,
      defaultScoring: 'dfs',
      trackPositions: false,
      strict: true,
      required: ['sku'],
      vectorPromotion: { threshold: 500, quantization: 'none' },
      patternValueLimit: 64,
      embedding: { adapter: 'catalogue-embedder', fields: { embedding: 'title' } },
    }

    await putIndexMetadata(coordinator, metadataWith(indexSettingsOf(requested)))
    const stored = await getIndexMetadata(coordinator, INDEX_NAME)
    const config = await getClusterIndexConfig(coordinator, INDEX_NAME, SCHEMA)

    expect(stored?.settings?.stopWordList).toEqual(['a', 'and', 'the'])
    expect(config).toEqual({ ...requested, language: 'english' })
    await coordinator.shutdown()
  })

  it('record the language module that the index resolves to when the request names none', () => {
    expect(indexSettingsOf({ schema: SCHEMA })).toEqual({ language: 'english' })
  })

  it('leave every option at its default where the metadata holds no settings', async () => {
    const coordinator = createInMemoryCoordinator()

    await putIndexMetadata(coordinator, metadataWith(undefined))

    await expect(getClusterIndexConfig(coordinator, INDEX_NAME, SCHEMA)).resolves.toEqual({ schema: SCHEMA })
    await coordinator.shutdown()
  })

  it('fail the read of metadata whose settings hold a value of the wrong type', async () => {
    const coordinator = createInMemoryCoordinator()
    const bytes = encode({ ...metadataWith(undefined), settings: { language: 'english', strict: 'yes' } })

    await coordinator.compareAndSet(indexConfigKey(INDEX_NAME), null, new Uint8Array(bytes))

    await expect(getIndexMetadata(coordinator, INDEX_NAME)).rejects.toMatchObject({
      code: ErrorCodes.CONTROLLER_METADATA_INVALID,
    })
    await coordinator.shutdown()
  })

  it('fail the read of metadata whose settings name no language', async () => {
    const coordinator = createInMemoryCoordinator()
    const bytes = encode({ ...metadataWith(undefined), settings: { strict: true } })

    await coordinator.compareAndSet(indexConfigKey(INDEX_NAME), null, new Uint8Array(bytes))

    await expect(getIndexMetadata(coordinator, INDEX_NAME)).rejects.toMatchObject({
      code: ErrorCodes.CONTROLLER_METADATA_INVALID,
    })
    await coordinator.shutdown()
  })
})

describe('a cluster create request whose configuration holds code', () => {
  const embedder: EmbeddingAdapter = {
    dimensions: 3,
    embed: async () => new Float32Array(3),
  }
  const codeValuedConfigs: Array<[string, IndexConfig]> = [
    ['a tokenizer instance', { schema: SCHEMA, tokenizer: { tokenize: () => [] } }],
    ['a stop word function', { schema: SCHEMA, stopWords: defaults => defaults }],
    [
      'an embedding adapter instance',
      { schema: SCHEMA, embedding: { adapter: embedder, fields: { embedding: 'title' } } },
    ],
  ]

  it.each(codeValuedConfigs)('fails with CONFIG_INVALID for %s and writes no metadata', async (_label, config) => {
    const coordinator = createInMemoryCoordinator()
    const engine = {
      createIndexWithUuid: async () => undefined,
      dropIndex: async () => undefined,
    }

    await expect(routeCreateIndex(INDEX_NAME, config, undefined, coordinator, engine)).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
    await expect(coordinator.get(indexConfigKey(INDEX_NAME))).resolves.toBeNull()
    await coordinator.shutdown()
  })
})
