import { createNarsilClient } from '@delali/narsil/client'
import { expect, test } from '@playwright/test'
import { mintGrant, openFeed, rawUpgrade, SYNC_SUBPROTOCOL } from './feed'
import { E2E_ORIGIN, E2E_SYNC_GRANT_MS } from './settings'

const SYNCED_INDEX = 'grant-check'
const OTHER_INDEX = 'grant-check-other'
const CLOSE_CREDENTIAL_EXPIRED = 4401
const CLOSE_RESYNC = 4410
const UNAUTHORIZED = 401
const NOT_FOUND = 404

const client = createNarsilClient({ url: `${E2E_ORIGIN}/api/narsil` })

function feedPath(indexName: string): string {
  return `/api/narsil/indexes/${indexName}/sync/feed`
}

function withSwappedCharacter(credential: string, fromEnd: number): string {
  const position = credential.length - fromEnd
  const swapped = credential[position] === 'A' ? 'B' : 'A'
  return `${credential.slice(0, position)}${swapped}${credential.slice(position + 1)}`
}

test.beforeAll(async () => {
  for (const name of [SYNCED_INDEX, OTHER_INDEX]) {
    const existing = await client.listIndexes()
    if (existing.some(index => index.name === name)) await client.dropIndex(name)
    await client.createIndex(name, { schema: { title: 'string' }, language: 'english' })
    await client.updateSync(name, { enabled: true })
  }
})

test('a current grant for the index opens the feed through the proxy, which closes with 4401 when the grant expires', async () => {
  const grant = await mintGrant(SYNCED_INDEX)
  const answer = await rawUpgrade(feedPath(SYNCED_INDEX), [SYNC_SUBPROTOCOL, grant.credential])
  expect(answer).toEqual({ kind: 'upgraded', protocol: SYNC_SUBPROTOCOL })

  const fresh = await mintGrant(SYNCED_INDEX)
  const feed = await openFeed(SYNCED_INDEX, fresh.credential)
  const closed = await feed.closed
  expect(closed.code).toBe(CLOSE_CREDENTIAL_EXPIRED)
  expect(Date.now()).toBeGreaterThanOrEqual(fresh.expiresAt)
  expect(closed.openMs).toBeLessThanOrEqual(E2E_SYNC_GRANT_MS + 1_000)
})

test('turning sync off closes an open feed with 4410 through the proxy', async () => {
  const grant = await mintGrant(OTHER_INDEX)
  const feed = await openFeed(OTHER_INDEX, grant.credential)
  await client.updateSync(OTHER_INDEX, { enabled: false })
  const closed = await feed.closed
  expect(closed.code).toBe(CLOSE_RESYNC)
  await client.updateSync(OTHER_INDEX, { enabled: true })
})

test('the upgrade refuses a grant once it has expired', async () => {
  const grant = await mintGrant(SYNCED_INDEX)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, grant.expiresAt - Date.now()) + 250))
  const answer = await rawUpgrade(feedPath(SYNCED_INDEX), [SYNC_SUBPROTOCOL, grant.credential])
  expect(answer.kind).toBe('refused')
  expect(answer.kind === 'refused' ? answer.status : 0).toBe(UNAUTHORIZED)
})

test('the upgrade refuses a forged grant, a tampered grant, and no grant at all', async () => {
  const grant = await mintGrant(SYNCED_INDEX)
  const [, encodedIndex, expiresAt, nonce] = grant.credential.split('.')
  const laterExpiry = String(Number(expiresAt) + 60 * 60 * 1000)
  const attempts = [
    [SYNC_SUBPROTOCOL, withSwappedCharacter(grant.credential, 10)],
    [SYNC_SUBPROTOCOL, withSwappedCharacter(grant.credential, 1)],
    [SYNC_SUBPROTOCOL, ['v1', encodedIndex, laterExpiry, nonce, grant.credential.split('.')[4]].join('.')],
    [SYNC_SUBPROTOCOL, `v1.${encodedIndex}.${laterExpiry}.${nonce}.${'A'.repeat(43)}`],
    [SYNC_SUBPROTOCOL, 'not-a-grant'],
    [SYNC_SUBPROTOCOL],
  ]
  for (const protocols of attempts) {
    const answer = await rawUpgrade(feedPath(SYNCED_INDEX), protocols)
    expect(answer.kind === 'refused' ? answer.status : 0, protocols.join(', ')).toBe(UNAUTHORIZED)
  }
})

test('the upgrade refuses a grant that the app signed for another index', async () => {
  const grant = await mintGrant(OTHER_INDEX)
  const answer = await rawUpgrade(feedPath(SYNCED_INDEX), [SYNC_SUBPROTOCOL, grant.credential])
  expect(answer.kind === 'refused' ? answer.status : 0).toBe(UNAUTHORIZED)
})

test('the proxy passes no other path and no query string on to the search server', async () => {
  const grant = await mintGrant(SYNCED_INDEX)
  const protocols = [SYNC_SUBPROTOCOL, grant.credential]
  const paths = [
    `/api/narsil/indexes/${SYNCED_INDEX}/sync/snapshot`,
    `/api/narsil/indexes/${SYNCED_INDEX}/search`,
    `/api/narsil/indexes/${SYNCED_INDEX}/sync/feed?index=${OTHER_INDEX}`,
    `/api/narsil/indexes/${SYNCED_INDEX}/sync/feed/extra`,
    '/api/narsil/health',
  ]
  for (const path of paths) {
    const answer = await rawUpgrade(path, protocols)
    expect(answer.kind === 'refused' ? answer.status : 0, path).toBe(NOT_FOUND)
    expect(answer.kind === 'refused' ? answer.body : '', path).toContain('Only the device sync feed')
  }
})
