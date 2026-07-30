import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { registerStopWords } from '../../analysis/registry'
import { createNarsil } from '../../narsil'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const distPackage = new URL('../../../dist/index.mjs', import.meta.url)
const built = existsSync(distEntry)

const BOUNDARY_STOP_WORDS = 'worker-boundary-stop-words'

function bootstrapModule(): string {
  const source = `import { registerStopWords } from ${JSON.stringify(distPackage.href)}
registerStopWords(${JSON.stringify(BOUNDARY_STOP_WORDS)}, new Set(['the']))`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

describe.skipIf(!built)('a promoted index searches under the analysis its config asks for', () => {
  it('answers from the worker, using the stop words the bootstrap module registered there', async () => {
    registerStopWords(BOUNDARY_STOP_WORDS, new Set())

    const narsil = await createNarsil({
      workers: {
        enabled: true,
        count: 1,
        promotionThreshold: 2,
        bootstrapModule: bootstrapModule(),
      },
    })

    await narsil.createIndex('prose', {
      schema: { title: 'string' },
      language: 'english',
      stopWords: BOUNDARY_STOP_WORDS,
    })

    const promoted = new Promise<number>(resolve => {
      narsil.on('workerPromote', payload => resolve(payload.workerCount))
    })
    const failed = new Promise<Error>(resolve => {
      narsil.on('workerPromoteFailure', payload => resolve(payload.error))
    })

    await narsil.insert('prose', { title: 'the rise of the machine' })
    await narsil.insert('prose', { title: 'the fall of the empire' })
    await narsil.insert('prose', { title: 'a quiet afternoon' })

    expect(await Promise.race([promoted, failed])).toBe(1)

    const indexed = await narsil.query('prose', { term: 'machine' })
    expect(indexed.hits.map(hit => hit.document.title)).toEqual(['the rise of the machine'])

    const stopped = await narsil.query('prose', { term: 'the' })
    expect(stopped.hits).toEqual([])

    await narsil.shutdown()
  }, 30_000)
})
