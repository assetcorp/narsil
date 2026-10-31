import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnalysisChange } from '../../../types/analysis-operations'
import type { QueryParams } from '../../../types/search'
import {
  allHitsOf,
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  NO_RIVER_SETTINGS,
  OLD_SETTINGS,
  type OracleSettings,
  PLAIN_LANGUAGE,
  PROBES,
  RIVER_STOP_WORDS,
  registerFixtures,
  STEMMING_LANGUAGE,
  STEMMING_SETTINGS,
  seededRandom,
  sentence,
} from './oracle'

const SCHEMA = { title: 'string' as const }
const OLD_CONFIG = {
  schema: SCHEMA,
  language: PLAIN_LANGUAGE,
  partitions: { maxPartitions: 3 },
}

async function filled(engine: Narsil, oracle: ChangeOracle, documents: number): Promise<void> {
  const random = seededRandom(100)
  const batch = []
  for (let i = 0; i < documents; i++) {
    const title = sentence(random)
    oracle.write(`doc-${i}`, title)
    batch.push({ id: `doc-${i}`, title })
  }
  await engine.createIndex('prose', OLD_CONFIG)
  await engine.insertBatch('prose', batch)
}

async function expectMatches(
  engine: Narsil,
  oracle: ChangeOracle,
  settings: OracleSettings,
  indexName = 'prose',
): Promise<void> {
  for (const probe of PROBES) {
    expect({ probe, hits: await allHitsOf(engine, indexName, probe) }).toEqual({
      probe,
      hits: oracle.matches(probe, settings),
    })
  }
}

function sameIds(left: string[], right: string[]): boolean {
  return left.join('\n') === right.join('\n')
}

function codeOf(error: unknown): string {
  return error instanceof NarsilError ? error.code : String(error)
}

describe('changing the analysis of a live index', () => {
  let engine: Narsil

  beforeEach(async () => {
    registerFixtures()
    engine = await createNarsil({ workers: { enabled: false } })
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('matches under a new tokeniser exactly as the oracle splits the words', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 400)
    await expectMatches(engine, oracle, OLD_SETTINGS)
    await engine.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    await expectMatches(engine, oracle, DASHES_SETTINGS)
    await engine.changeAnalysis('prose', { tokenizer: null })
    await expectMatches(engine, oracle, OLD_SETTINGS)
  })

  it('matches under a registered stop word set and a literal one', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 400)
    await engine.changeAnalysis('prose', { stopWords: RIVER_STOP_WORDS })
    await expectMatches(engine, oracle, NO_RIVER_SETTINGS)
    await engine.changeAnalysis('prose', { stopWords: [] })
    await expectMatches(engine, oracle, OLD_SETTINGS)
    await engine.changeAnalysis('prose', { stopWords: ['river'] })
    await expectMatches(engine, oracle, NO_RIVER_SETTINGS)
  })

  it('answers a language change as a new index with that language answers', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 400)
    await engine.createIndex('fresh', { ...OLD_CONFIG, language: STEMMING_LANGUAGE })
    await engine.insertBatch(
      'fresh',
      [...oracle.documents].map(([id, title]) => ({ id, title })),
    )
    await engine.changeAnalysis('prose', { language: STEMMING_LANGUAGE })
    expect(engine.getStats('prose').language).toBe(STEMMING_LANGUAGE)
    for (const probe of PROBES) {
      expect(await allHitsOf(engine, 'prose', probe)).toEqual(await allHitsOf(engine, 'fresh', probe))
    }
    await expectMatches(engine, oracle, STEMMING_SETTINGS)
  })

  it('answers every search under one set of settings while writes arrive, and keeps every write', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 12_000)
    const random = seededRandom(7)
    let changing = true
    const change = engine.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER }).finally(() => {
      changing = false
    })
    let written = 0
    let sawOld = false
    while (changing) {
      const title = sentence(random)
      const id = `live-${written}`
      written += 1
      oracle.write(id, title)
      await engine.insert('prose', { title }, id)
      const removed = `doc-${written}`
      if (written % 3 === 0 && oracle.documents.has(removed)) {
        oracle.remove(removed)
        await engine.remove('prose', removed)
      }
      const hits = await allHitsOf(engine, 'prose', 'wall')
      const underOld = oracle.matches('wall', OLD_SETTINGS)
      const underNew = oracle.matches('wall', DASHES_SETTINGS)
      expect(sameIds(hits, underOld) || sameIds(hits, underNew)).toBe(true)
      sawOld ||= sameIds(hits, underOld) && !sameIds(hits, underNew)
      await new Promise(resolve => setImmediate(resolve))
    }
    await change
    expect(written).toBeGreaterThan(0)
    expect(sawOld).toBe(true)
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })

  it.each<[string, AnalysisChange, string]>([
    ['language', { language: 'nowhere-language' }, ErrorCodes.LANGUAGE_NOT_SUPPORTED],
    ['tokeniser', { tokenizer: 'nowhere-tokenizer' }, ErrorCodes.CONFIG_INVALID],
    ['stop word set', { stopWords: 'nowhere-stop-words' }, ErrorCodes.CONFIG_INVALID],
  ])('refuses an unregistered %s with the error that index creation returns', async (_kind, change, code) => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 50)
    const creation = await engine.createIndex('other', { ...OLD_CONFIG, ...change } as never).catch(codeOf)
    expect(creation).toBe(code)
    expect(await engine.changeAnalysis('prose', change).catch(codeOf)).toBe(code)
    await expectMatches(engine, oracle, OLD_SETTINGS)
  })

  it.each<[string, unknown]>([
    ['a tokeniser instance', { tokenizer: { tokenize: () => [] } }],
    ['a stop word function', { stopWords: (defaults: Set<string>) => defaults }],
    ['a list that holds a number', { stopWords: ['river', 7] }],
    ['a change that is no object', 'english'],
  ])('refuses %s and keeps answering', async (_kind, change) => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 50)
    expect(await engine.changeAnalysis('prose', change as AnalysisChange).catch(codeOf)).toBe(ErrorCodes.CONFIG_INVALID)
    await expectMatches(engine, oracle, OLD_SETTINGS)
  })

  it('completes with no rebuild for the settings that the index holds', async () => {
    const oracle = new ChangeOracle()
    const events: string[] = []
    engine.on('analysisRebuild', event => events.push(event.status))
    await filled(engine, oracle, 50)
    await engine.changeAnalysis('prose', { language: PLAIN_LANGUAGE, tokenizer: null })
    await engine.changeAnalysis('prose', {})
    expect(events).toEqual([])
  })

  it('lets the latest of two changes win and tells the first caller', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 12_000)
    const first = engine.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    const firstOutcome = first.catch(codeOf)
    await new Promise(resolve => setTimeout(resolve, 1))
    await engine.changeAnalysis('prose', { stopWords: RIVER_STOP_WORDS })
    expect(await firstOutcome).toBe(ErrorCodes.ANALYSIS_CHANGE_REPLACED)
    await expectMatches(engine, oracle, NO_RIVER_SETTINGS)
  })

  it('refuses a synonym word that the new settings would remove, before it builds', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 50)
    await engine.updateSynonyms('prose', [{ words: ['river', 'stone'] }])
    expect(await engine.changeAnalysis('prose', { stopWords: RIVER_STOP_WORDS }).catch(codeOf)).toBe(
      ErrorCodes.CONFIG_INVALID,
    )
    expect(await allHitsOf(engine, 'prose', 'sea-wall')).toEqual(oracle.matches('sea-wall', OLD_SETTINGS))
    expect(await engine.getSynonyms('prose')).toEqual([{ words: ['river', 'stone'] }])
  })

  it('refuses a rebalance during a change and a change during a rebalance', async () => {
    const oracle = new ChangeOracle()
    await filled(engine, oracle, 12_000)
    const change = engine.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(await engine.rebalance('prose', 2).catch(codeOf)).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    await change
    const rebalance = engine.rebalance('prose', 2)
    expect(await engine.changeAnalysis('prose', { stopWords: ['river'] }).catch(codeOf)).toBe(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    )
    await rebalance
    await expectMatches(engine, oracle, DASHES_SETTINGS)
  })

  it('leaves vector results as they were', async () => {
    await engine.createIndex('mixed', { ...OLD_CONFIG, schema: { title: 'string', embedding: 'vector[3]' } })
    const documents = [
      { id: 'near', title: 'sea-wall', embedding: [1, 0, 0] },
      { id: 'middle', title: 'river', embedding: [0.8, 0.6, 0] },
      { id: 'far', title: 'stone', embedding: [0, 0, 1] },
    ]
    await engine.insertBatch('mixed', documents)
    const search: QueryParams = { mode: 'vector', vector: { field: 'embedding', value: [1, 0, 0] }, limit: 3 }
    const before = await engine.query('mixed', search)
    await engine.changeAnalysis('mixed', { tokenizer: DASHES_TOKENIZER })
    const after = await engine.query('mixed', search)
    expect(after.hits.map(hit => [hit.id, hit.score])).toEqual(before.hits.map(hit => [hit.id, hit.score]))
    expect(after.hits.map(hit => hit.id)).toEqual(['near', 'middle', 'far'])
  })
})
