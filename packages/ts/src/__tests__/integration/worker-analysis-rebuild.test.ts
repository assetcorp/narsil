import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerLanguage } from '../../languages/registry'
import { createNarsil } from '../../narsil'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const distPackage = new URL('../../../dist/index.mjs', import.meta.url)
const built = existsSync(distEntry)

const LANGUAGE = 'promoted-analysis'

const WORKER_ONLY_STOP_WORD = 'water'

function bootstrapModule(): string {
  const source = `import { registerLanguage } from ${JSON.stringify(distPackage.href)}
registerLanguage({
  name: ${JSON.stringify(LANGUAGE)},
  revision: '2',
  stemmer: token => (token.endsWith('ing') ? token.slice(0, -3) : token),
  stopWords: new Set([${JSON.stringify(WORKER_ONLY_STOP_WORD)}]),
})`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

describe.skipIf(!built)('an index promoted to a worker thread', () => {
  it('answers from rebuilt terms once the rebuild has resynchronised the worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'narsil-worker-rebuild-'))
    const documents = Array.from({ length: 4 }, (_, i) => ({ id: `doc-${i}`, title: 'jumping water' }))

    try {
      registerLanguage({ name: LANGUAGE, revision: '1', stemmer: null, stopWords: new Set<string>() })

      const writer = await createNarsil({ durability: { directory: dir } })
      await writer.createIndex('prose', { schema: { title: 'string' }, language: LANGUAGE })
      await writer.insertBatch('prose', documents)
      await writer.checkpoint('prose')
      await writer.shutdown()

      registerLanguage({
        name: LANGUAGE,
        revision: '2',
        stemmer: (token: string) => (token.endsWith('ing') ? token.slice(0, -3) : token),
        stopWords: new Set<string>(),
      })

      const narsil = await createNarsil({
        durability: { directory: dir },
        analysis: { rebuild: 'manual' },
        workers: { enabled: true, count: 1, promotionThreshold: 2, bootstrapModule: bootstrapModule() },
      })

      const promoted = new Promise<number>(resolve => {
        narsil.on('workerPromote', payload => resolve(payload.workerCount))
      })
      const promotionFailed = new Promise<Error>(resolve => {
        narsil.on('workerPromoteFailure', payload => resolve(payload.error))
      })

      await narsil.createIndex('trigger', { schema: { title: 'string' } })
      await narsil.insert('trigger', { title: 'first' })
      await narsil.insert('trigger', { title: 'second' })
      await narsil.insert('trigger', { title: 'third' })

      expect(await Promise.race([promoted, promotionFailed])).toBe(1)

      const stale = await narsil.query('prose', { term: 'jump' })
      expect(stale.analysisStale).toBe(true)
      expect(stale.hits).toHaveLength(0)

      await narsil.rebuildAnalysis('prose')

      const rebuilt = await narsil.query('prose', { term: 'jump' })
      expect(rebuilt.analysisStale).toBeUndefined()
      expect(rebuilt.hits).toHaveLength(4)

      const unstemmed = await narsil.query('prose', { term: 'jumping' })
      expect(unstemmed.hits).toHaveLength(4)

      const bothCopies = await Promise.all([
        narsil.query('prose', { term: WORKER_ONLY_STOP_WORD }),
        narsil.query('prose', { term: WORKER_ONLY_STOP_WORD }),
      ])
      expect(bothCopies.filter(answer => answer.hits.length === 0)).toHaveLength(1)

      await narsil.shutdown()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
