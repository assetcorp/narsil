import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const run = promisify(execFile)
const BROWSER_ENTRY = fileURLToPath(new URL('../../../../dist/index.browser.mjs', import.meta.url))
const INDEX = 'catalogue'
const WORDS = ['amber', 'cobalt', 'jade', 'river', 'stone', 'lake'] as const

type Titles = ReadonlyArray<readonly [string, string]>

const FIRST_TITLES: Titles = [
  ['d1', 'amber river'],
  ['d2', 'amber stone'],
  ['d3', 'cobalt river'],
  ['d4', 'cobalt stone'],
  ['d5', 'jade river'],
  ['d6', 'jade stone'],
]

const PROBE = `
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [entry, path, storeDirectory, inputJson] = process.argv.slice(2)
const input = JSON.parse(inputJson)
const { createNarsil } = await import(entry)

function fileOf(key) {
  return join(storeDirectory, encodeURIComponent(key))
}

const fileStore = {
  async save(key, data) {
    await writeFile(fileOf(key), data)
  },
  async saveIfAbsent(key, data) {
    try {
      await writeFile(fileOf(key), data, { flag: 'wx' })
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  },
  async load(key) {
    try {
      return new Uint8Array(await readFile(fileOf(key)))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  },
  async delete(key) {
    await rm(fileOf(key), { force: true })
  },
  async list(prefix) {
    return (await readdir(storeDirectory)).map(name => decodeURIComponent(name)).filter(key => key.startsWith(prefix))
  },
}

const durable = path.startsWith('durable')
const engine = await createNarsil(
  durable ? { persistence: fileStore, durability: { tier: 'snapshot' }, workers: { enabled: false } } : { workers: { enabled: false } },
)
const index = input.index
if (path !== 'durable-open') {
  await engine.createIndex(index, { schema: { title: 'string' }, partitions: { maxPartitions: 3 } })
  for (const [id, title] of input.first) await engine.insert(index, { title }, id)
}
switch (path) {
  case 'remove':
    await engine.remove(index, 'd1')
    break
  case 'removeBatch':
    await engine.removeBatch(index, ['d1', 'd3'])
    break
  case 'update':
    await engine.update(index, 'd1', { title: 'cobalt lake' })
    break
  case 'updateBatch':
    await engine.updateBatch(index, [
      { docId: 'd2', document: { title: 'jade lake' } },
      { docId: 'd4', document: { title: 'amber lake' } },
    ])
    break
  case 'clear':
    await engine.clear(index)
    await engine.insert(index, { title: 'amber lake' }, 'd7')
    await engine.remove(index, 'd7')
    await engine.insert(index, { title: 'jade lake' }, 'd8')
    break
  case 'rebalance':
    await engine.rebalance(index, 3)
    await engine.remove(index, 'd5')
    break
  case 'rebuildAnalysis':
    await engine.rebuildAnalysis(index)
    await engine.remove(index, 'd6')
    break
  case 'changeAnalysis':
    await engine.changeAnalysis(index, { stopWords: ['the'] })
    await engine.remove(index, 'd2')
    break
  case 'restore': {
    const archive = new Uint8Array(await new Response(await engine.snapshot(index)).arrayBuffer())
    await engine.dropIndex(index)
    await engine.restore(index, archive)
    await engine.remove(index, 'd3')
    break
  }
  case 'durable-write':
    await engine.checkpoint(index)
    await engine.remove(index, 'd1')
    await engine.update(index, 'd2', { title: 'jade lake' })
    await engine.checkpoint(index)
    break
  case 'durable-open':
    await engine.remove(index, 'd4')
    break
  default:
    throw new Error('unknown path ' + path)
}
const answers = {}
for (const word of input.words) {
  const result = await engine.query(index, { term: word, limit: 100 })
  answers[word] = result.hits.map(hit => hit.id).sort()
}
await engine.shutdown()
console.log(JSON.stringify(answers))
`

let work: string | null = null

function oracle(titles: ReadonlyMap<string, string>): Record<string, string[]> {
  const answers: Record<string, string[]> = {}
  for (const word of WORDS) {
    answers[word] = [...titles]
      .filter(([, title]) => title.split(' ').includes(word))
      .map(([id]) => id)
      .sort()
  }
  return answers
}

function titlesAfter(change: (titles: Map<string, string>) => void): Record<string, string[]> {
  const titles = new Map(FIRST_TITLES)
  change(titles)
  return oracle(titles)
}

async function answersOf(path: string, storeDirectory: string): Promise<Record<string, string[]>> {
  if (work === null) throw new Error('The suite never prepared a work directory')
  const input = JSON.stringify({ index: INDEX, first: FIRST_TITLES, words: WORDS })
  const { stdout } = await run(process.execPath, [
    join(work, 'probe.mjs'),
    pathToFileURL(BROWSER_ENTRY).href,
    path,
    storeDirectory,
    input,
  ])
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as Record<string, string[]>
}

const CASES: ReadonlyArray<readonly [string, (titles: Map<string, string>) => void]> = [
  ['remove', titles => titles.delete('d1')],
  [
    'removeBatch',
    titles => {
      titles.delete('d1')
      titles.delete('d3')
    },
  ],
  ['update', titles => titles.set('d1', 'cobalt lake')],
  [
    'updateBatch',
    titles => {
      titles.set('d2', 'jade lake')
      titles.set('d4', 'amber lake')
    },
  ],
  [
    'clear',
    titles => {
      titles.clear()
      titles.set('d8', 'jade lake')
    },
  ],
  ['rebalance', titles => titles.delete('d5')],
  ['rebuildAnalysis', titles => titles.delete('d6')],
  ['changeAnalysis', titles => titles.delete('d2')],
  ['restore', titles => titles.delete('d3')],
]

describe.skipIf(!existsSync(BROWSER_ENTRY))(
  'a browser engine whose first write after single inserts removes text',
  () => {
    beforeAll(async () => {
      work = await mkdtemp(join(tmpdir(), 'narsil-growing-removal-'))
      await writeFile(join(work, 'probe.mjs'), PROBE)
    })

    afterAll(async () => {
      if (work !== null) await rm(work, { recursive: true, force: true })
      work = null
    })

    it.each(CASES)('answers like the oracle after %s in a fresh process', async (path, change) => {
      if (work === null) throw new Error('The suite never prepared a work directory')
      expect(await answersOf(path, work)).toEqual(titlesAfter(change))
    })

    it('reopens a durable index whose checkpoint holds removals and updates, then removes from it', async () => {
      const store = await mkdtemp(join(tmpdir(), 'narsil-growing-removal-store-'))
      try {
        expect(await answersOf('durable-write', store)).toEqual(
          titlesAfter(titles => {
            titles.delete('d1')
            titles.set('d2', 'jade lake')
          }),
        )
        expect(await answersOf('durable-open', store)).toEqual(
          titlesAfter(titles => {
            titles.delete('d1')
            titles.set('d2', 'jade lake')
            titles.delete('d4')
          }),
        )
      } finally {
        await rm(store, { recursive: true, force: true })
      }
    })
  },
)
