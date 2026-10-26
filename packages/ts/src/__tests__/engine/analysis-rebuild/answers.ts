import { expect } from 'vitest'
import type { Narsil } from '../../../narsil'
import { type OracleCorpus, PROBES } from './oracle'

const PAGE = 5_000

export async function expectAnswersFrom(engine: Narsil, corpus: OracleCorpus, state: 'old' | 'new'): Promise<void> {
  for (const probe of PROBES) {
    const hits: string[] = []
    let searchAfter: string | undefined
    for (;;) {
      const page = await engine.query('prose', { term: probe, limit: PAGE, ...(searchAfter ? { searchAfter } : {}) })
      expect({ probe, state: page.analysisStale === true ? 'old' : 'new' }).toEqual({ probe, state })
      for (const hit of page.hits) hits.push(hit.id)
      if (page.hits.length < PAGE || page.cursor === undefined) break
      searchAfter = page.cursor
    }
    expect({ probe, hits: hits.sort() }).toEqual({ probe, hits: corpus.matches(probe, state) })
  }
}
