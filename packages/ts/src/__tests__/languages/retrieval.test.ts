import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../languages/registry'
import { createNarsil, type Narsil } from '../../narsil'
import { languageFixtures } from './fixtures'

describe('a reader finds a document by searching the language it was written in', () => {
  for (const fixture of languageFixtures) {
    describe(fixture.module.name, () => {
      let narsil: Narsil

      beforeEach(async () => {
        registerLanguage(fixture.module)
        narsil = await createNarsil()
        await narsil.createIndex('prose', {
          schema: { body: 'string' },
          language: fixture.module.name,
        })
        await narsil.insertBatch(
          'prose',
          fixture.retrievable.map((entry, index) => ({ id: `doc-${index}`, body: entry.text })),
        )
      })

      afterEach(async () => {
        await narsil.shutdown()
      })

      fixture.retrievable.forEach((entry, index) => {
        it(`finds "${entry.query}"`, async () => {
          const result = await narsil.query('prose', { term: entry.query })
          expect(result.hits.map(hit => hit.id)).toContain(`doc-${index}`)
        })
      })
    })
  }
})
