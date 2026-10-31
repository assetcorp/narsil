import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../errors'

vi.setConfig({ testTimeout: 120_000 })

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../../../dist/', import.meta.url))
const BROWSER_ENTRY = 'index.browser.mjs'
const BROWSER_CHUNKS = 'browser'
const PHRASE_CHUNK = /^phrase-module-.*\.mjs$/

const PROBE = `
import { rename } from 'node:fs/promises'
const [entry, heldChunk, phraseChunk] = process.argv.slice(2)
const { createNarsil } = await import(entry)
const engine = await createNarsil({ workers: { enabled: false } })
await engine.createIndex('pantry', { schema: { title: 'string' } })
await engine.insert('pantry', { title: 'olive oil' }, 'in-order')
await engine.insert('pantry', { title: 'oil olive' }, 'reversed')
const outcome = {}
async function attempt(name, read) {
  try {
    outcome[name] = await read()
  } catch (err) {
    outcome[name] = { code: err.code }
  }
}
const idsOf = answer => ({ ids: answer.hits.map(hit => hit.id).sort() })
await attempt('plain', async () =>
  idsOf(await engine.query('pantry', { term: 'olive', highlight: { fields: ['title'] } })),
)
await attempt('plainCount', async () => engine.preflight('pantry', { term: 'olive' }).then(({ count }) => ({ count })))
await attempt('quoted', async () => idsOf(await engine.query('pantry', { term: '"olive oil"' })))
await attempt('quotedCount', async () => engine.preflight('pantry', { term: '"olive oil"' }).then(({ count }) => ({ count })))
await attempt('plainAfterFailure', async () => idsOf(await engine.query('pantry', { term: 'olive' })))
await rename(heldChunk, phraseChunk)
await attempt('quotedOnceRestored', async () => idsOf(await engine.query('pantry', { term: '"olive oil"' })))
await engine.shutdown()
console.log(JSON.stringify(outcome))
`

let copy: string | null = null

afterEach(async () => {
  if (copy !== null) await rm(copy, { recursive: true, force: true })
  copy = null
})

describe('a browser that cannot download the phrase code', () => {
  it.skipIf(!existsSync(join(DIST, BROWSER_ENTRY)))(
    'answers plain queries, refuses a quoted one with a typed error, and recovers once the file returns',
    async () => {
      copy = await mkdtemp(join(DIST, 'phrase-code-loading-'))
      await cp(join(DIST, BROWSER_ENTRY), join(copy, BROWSER_ENTRY))
      await cp(join(DIST, BROWSER_CHUNKS), join(copy, BROWSER_CHUNKS), { recursive: true })
      const chunks = (await readdir(join(copy, BROWSER_CHUNKS))).filter(file => PHRASE_CHUNK.test(file))
      expect(chunks).toHaveLength(1)
      const phraseChunk = join(copy, BROWSER_CHUNKS, chunks[0])
      const heldChunk = `${phraseChunk}.held`
      await rename(phraseChunk, heldChunk)
      const probe = join(copy, 'probe.mjs')
      await writeFile(probe, PROBE)

      const { stdout } = await run(process.execPath, [
        probe,
        pathToFileURL(join(copy, BROWSER_ENTRY)).href,
        heldChunk,
        phraseChunk,
      ])

      expect(JSON.parse(stdout)).toEqual({
        plain: { ids: ['in-order', 'reversed'] },
        plainCount: { count: 2 },
        quoted: { code: ErrorCodes.SEARCH_PHRASE_NOT_READY },
        quotedCount: { code: ErrorCodes.SEARCH_PHRASE_NOT_READY },
        plainAfterFailure: { ids: ['in-order', 'reversed'] },
        quotedOnceRestored: { ids: ['in-order'] },
      })
    },
  )
})
