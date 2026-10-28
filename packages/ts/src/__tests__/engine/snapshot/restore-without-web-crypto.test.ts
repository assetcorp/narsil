import { createHash } from 'node:crypto'
import { access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import {
  archiveBytes,
  configFor,
  fill,
  holdsGeneration,
  LIVE,
  NEW,
  newDirectory,
  OLD,
  openEngine,
  SOURCE,
} from './restore-fixtures'

const roots: string[] = []
const engines: Narsil[] = []

beforeEach(() => {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true })
})

afterEach(async () => {
  Reflect.deleteProperty(globalThis.crypto, 'subtle')
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function digestOf(indexName: string): string {
  return createHash('sha256').update(indexName, 'utf8').digest('hex')
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

const NAME_SPANNING_TWO_SHA256_BLOCKS = `n${'x'.repeat(55)}`

describe('a restore on a platform without Web Crypto, as in a browser page served over plain HTTP', () => {
  it('replaces an index, drops it, and reopens without it on a snapshot-tier engine', async () => {
    expect(globalThis.crypto.subtle).toBeUndefined()
    const directory = await newDirectory(roots)
    const engine = await openEngine(configFor('snapshot', directory, false), engines)
    await fill(engine, LIVE, OLD.documents)
    await fill(engine, SOURCE, NEW.documents)

    await engine.restore(LIVE, await archiveBytes(engine, SOURCE))

    expect(await holdsGeneration(engine, LIVE, NEW)).toBe(true)
    await engine.dropIndex(LIVE)
    await engine.shutdown()
    expect(await exists(join(directory, `.swap-${digestOf(LIVE)}`))).toBe(false)
    const reopened = await openEngine(configFor('snapshot', directory, false), engines)
    expect(await reopened.listIndexes()).not.toContainEqual(expect.objectContaining({ name: LIVE }))
  }, 30_000)

  it('finds the journal under the SHA-256 of an index name that spans two blocks, and refuses its hostile prefix', async () => {
    const name = NAME_SPANNING_TWO_SHA256_BLOCKS
    const directory = await newDirectory(roots)
    const engine = await openEngine(configFor('snapshot', directory, false), engines)
    await engine.createIndex(name, { schema: { body: 'string' } })
    await engine.insert(name, { body: 'the lantern by the quay' }, 'doc-1')
    await engine.checkpoint(name)
    await engine.shutdown()
    await writeFile(join(directory, `.swap-${digestOf(name)}`), `${name}\n../`)

    await expect(openEngine(configFor('snapshot', directory, false), engines)).rejects.toMatchObject({
      code: 'PERSISTENCE_LOAD_FAILED',
    })
  }, 30_000)
})
