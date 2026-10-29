import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../index'

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
})
