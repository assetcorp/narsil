import { expect } from 'vitest'
import type { SynonymRule } from '../../../types/synonyms'
import { type GarageCluster, PARTITION_COUNT, startGarageCluster } from '../synonyms/cluster-harness'
import { garageCorpus, INDEX, LANGUAGE_NAME, SCHEMA } from '../synonyms/corpus'

const DATA_NODES = ['node-a', 'node-b', 'node-c']
const DOCUMENTS_PER_INDEX = 300

export async function clusterWithRouter(): Promise<GarageCluster> {
  const cluster = await startGarageCluster(DATA_NODES)
  await cluster.startNode('router', ['coordinator'])
  return cluster
}

export async function createAndFill(
  cluster: GarageCluster,
  nodeId: string,
  seed: number,
  synonyms: SynonymRule[],
): Promise<ReturnType<typeof garageCorpus>> {
  const documents = garageCorpus(DOCUMENTS_PER_INDEX, seed, `gen${seed}-`)
  await cluster
    .node(nodeId)
    .createIndex(
      INDEX,
      { schema: SCHEMA, language: LANGUAGE_NAME, synonyms },
      { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
    )
  const inserted = await cluster.node(nodeId).insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
  return documents
}
