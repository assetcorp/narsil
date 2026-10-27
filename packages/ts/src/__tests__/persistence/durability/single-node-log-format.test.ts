import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../index'
import type { Narsil } from '../../../narsil'

const FIXTURE = fileURLToPath(new URL('../fixtures/single-node-log/', import.meta.url))
const INDEX = 'ledger'
const ACCOUNTS = 8

function expectedAccounts(): Map<string, { title: string; amount: number }> {
  const accounts = new Map<string, { title: string; amount: number }>()
  for (let i = 0; i < ACCOUNTS; i++)
    accounts.set(`account-${i}`, { title: `account ${i} opening balance`, amount: i * 10 })
  accounts.set('account-3', { title: 'account 3 after a deposit', amount: 75 })
  accounts.delete('account-5')
  return accounts
}

async function writeTheFixtureHistory(engine: Narsil): Promise<void> {
  await engine.createIndex(INDEX, { schema: { title: 'string', amount: 'number' }, partitions: { maxPartitions: 2 } })
  for (let i = 0; i < ACCOUNTS; i++) {
    await engine.insert(INDEX, { title: `account ${i} opening balance`, amount: i * 10 }, `account-${i}`)
  }
  await engine.update(INDEX, 'account-3', { title: 'account 3 after a deposit', amount: 75 })
  await engine.remove(INDEX, 'account-5')
}

async function logFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const walRoot = join(root, INDEX, 'wal')
  for (const entry of await readdir(walRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.set(relative(walRoot, path), await readFile(path))
  }
  return files
}

describe('an engine outside a cluster keeps the write-ahead log that main writes', () => {
  const scratch: string[] = []

  afterEach(async () => {
    for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  async function freshDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-single-node-log-'))
    scratch.push(directory)
    return directory
  }

  it('recovers every document from a log that main wrote', async () => {
    const directory = await freshDirectory()
    await cp(FIXTURE, directory, { recursive: true })
    const engine = await createNarsil({ workers: { enabled: false }, durability: { directory, mode: 'sync' } })
    try {
      const expected = expectedAccounts()
      expect(await engine.countDocuments(INDEX)).toBe(expected.size)
      for (const [id, account] of expected) {
        expect(await engine.get(INDEX, id)).toMatchObject(account)
      }
      expect(await engine.get(INDEX, 'account-5')).toBeUndefined()
    } finally {
      await engine.shutdown()
    }
  })

  it('writes the same history into log files identical byte for byte to the ones main wrote', async () => {
    const directory = await freshDirectory()
    const engine = await createNarsil({
      workers: { enabled: false },
      durability: { directory, mode: 'sync', checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000 },
    })
    let written: Map<string, Buffer>
    try {
      await writeTheFixtureHistory(engine)
      written = await logFiles(directory)
    } finally {
      await engine.shutdown()
    }
    const fromMain = await logFiles(FIXTURE)
    expect([...written.keys()].sort()).toEqual([...fromMain.keys()].sort())
    for (const [file, bytes] of fromMain) {
      expect(written.get(file)?.equals(bytes), file).toBe(true)
    }
  })
})
