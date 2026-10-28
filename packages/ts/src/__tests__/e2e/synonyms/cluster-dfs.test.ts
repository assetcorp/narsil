import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { QueryParams } from '../../../types/search'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { createClusterGarage, type GarageCluster, startGarageCluster } from './cluster-harness'
import { garageCorpus, INDEX, registerGarageLanguage } from './corpus'
import { documentFrequencies } from './oracle'

const CONSONANTS = 'bcdfghjklmnp'
const PREFIX_WORDS = Array.from(
  { length: 120 },
  (_, at) => `zq${CONSONANTS[Math.floor(at / CONSONANTS.length)]}${CONSONANTS[at % CONSONANTS.length]}`,
)
const COMPLETION_CAP = 50

interface StatsRequest {
  terms: string[]
  tokens?: string[] | null
  expansion?: Record<string, unknown> | null
}

interface StatsAnswer {
  docFrequencies: Record<string, number>
  expanded?: string[] | null
}

const clusters: GarageCluster[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown()
})

function prefixCorpus(count: number, seed: number) {
  const random = seededRandom(seed)
  return garageCorpus(count, seed, 'zq').map(document => ({
    ...document,
    body: `${document.body} ${Array.from(
      { length: 4 },
      () => PREFIX_WORDS[Math.floor(random() * random() * PREFIX_WORDS.length)],
    ).join(' ')}`,
  }))
}

function decoded<T>(payload: Uint8Array): T {
  return decode(payload) as T
}

describe('DFS statistics on a three-node cluster', () => {
  it('counts every completion that any partition reaches on every node, with a second round for the ones a node left out', async () => {
    const documents = prefixCorpus(1_500, 93)
    const cluster = await startGarageCluster(['node-a', 'node-b', 'node-c'])
    clusters.push(cluster)
    await createClusterGarage(cluster, 'node-a', documents, [])
    cluster.exchanges.length = 0

    const result = await cluster
      .node('node-a')
      .query(INDEX, { term: 'zq', prefix: true, scoring: 'dfs', limit: 10 } as QueryParams)
    expect(result.hits.length).toBeGreaterThan(0)

    const stats = cluster.exchanges.filter(exchange => exchange.request.type === 'query.stats')
    const first = stats.filter(exchange => decoded<StatsRequest>(exchange.request.payload).tokens == null)
    const second = stats.filter(exchange => decoded<StatsRequest>(exchange.request.payload).tokens != null)
    expect(first.length).toBe(3)
    expect(second.length).toBeGreaterThan(0)
    for (const exchange of first) {
      expect(decoded<StatsRequest>(exchange.request.payload).expansion).toMatchObject({ prefix: true })
    }

    const reached = new Set<string>()
    for (const exchange of first) {
      for (const token of decoded<StatsAnswer>(exchange.response.payload).expanded ?? []) reached.add(token)
    }
    expect(reached.size).toBeGreaterThan(COMPLETION_CAP)

    const searches = cluster.exchanges.filter(exchange => exchange.request.type === 'query.search')
    expect(searches.length).toBe(3)
    const truth = documentFrequencies(documents)
    for (const search of searches) {
      const { globalStats } = decoded<{ globalStats: { docFrequencies: Record<string, number> } }>(
        search.request.payload,
      )
      for (const token of reached) {
        expect(globalStats.docFrequencies[token], `document frequency of ${token}`).toBe(truth.get(token))
      }
      for (const [token, frequency] of Object.entries(globalStats.docFrequencies)) {
        expect(frequency, `document frequency of ${token}`).toBe(truth.get(token))
      }
    }
  }, 120_000)

  it('refuses a malformed statistics request from a peer and answers one whose new members are absent or null', async () => {
    const cluster = await startGarageCluster(['node-a', 'node-b'])
    clusters.push(cluster)
    await createClusterGarage(cluster, 'node-a', prefixCorpus(200, 94), [])
    const transport = cluster.transports.get('node-a')
    if (transport === undefined) throw new Error('node-a has no transport')
    const table = await cluster.watched.coordinator.getAllocation(INDEX)
    const partitionIds = [...(table?.assignments.entries() ?? [])]
      .filter(([, assignment]) => assignment.primary === 'node-b')
      .map(([partitionId]) => partitionId)
    expect(partitionIds.length).toBeGreaterThan(0)
    const ask = (extra: Record<string, unknown>) =>
      transport.send('node-b', {
        type: 'query.stats',
        sourceId: 'node-a',
        requestId: `stats-${Math.random()}`,
        payload: encode({ indexName: INDEX, partitionIds, terms: ['zq'], ...extra }),
      })

    for (const extra of [
      { expansion: 'prefix' },
      { expansion: { tolerance: 11 } },
      { expansion: { prefixLength: 1_025 } },
      { tokens: [null] },
    ]) {
      const answer = await ask(extra)
      expect(answer.type, JSON.stringify(extra)).toMatch(/\.error$/)
      const refusal = decoded<{ code: string; message: string }>(answer.payload)
      expect(refusal.code).toBe('CONFIG_INVALID')
      expect(refusal.message).toMatch(Object.keys(extra)[0])
    }

    const truth = documentFrequencies(prefixCorpus(200, 94))
    for (const extra of [{}, { expansion: null, tokens: null }, { expansion: { prefix: true }, tokens: ['zqbb'] }]) {
      const answer = await ask(extra)
      expect(answer.type, JSON.stringify(extra)).toBe('query.stats_result')
      const { docFrequencies } = decoded<StatsAnswer>(answer.payload)
      for (const frequency of Object.values(docFrequencies)) expect(frequency).toBeGreaterThan(0)
      expect(Object.keys(docFrequencies).every(token => truth.has(token))).toBe(true)
    }
  }, 60_000)
})
