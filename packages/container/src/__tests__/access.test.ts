import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_KEY,
  call,
  errorCodeOf,
  READ_KEY,
  type RunningNode,
  removeFolder,
  secondsFromNow,
  signToken,
  startNode,
  temporaryFolder,
} from './support/node'

const SHOP = 'shop'
const PRIVATE = 'payroll'
const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
const CREDENTIAL_EXPIRED_CLOSE_CODE = 4401
const SUGGESTIONS_KEY = 'query-suggestions-key-for-container-tests'
const SUGGESTION_SETTING = { enabled: true, fields: ['title'], minPeople: 2, minResults: 1, schedule: 'off' }
const OTHER_KEY = 'a-key-that-this-node-was-never-given-0123'

const folder = temporaryFolder('access')
let node: RunningNode

beforeAll(async () => {
  node = await startNode({
    NARSIL_DATA_DIR: folder,
    NARSIL_WORKERS: '0',
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_READ_KEY: READ_KEY,
    NARSIL_CHANGES: 'true',
    NARSIL_QUERY_SUGGESTIONS: 'true',
    NARSIL_QUERY_SUGGESTIONS_KEY: SUGGESTIONS_KEY,
  })
  for (const name of [SHOP, PRIVATE]) {
    const created = await call(node, 'POST', '/indexes', {
      credential: ADMIN_KEY,
      body: { name, config: { schema: { title: 'string' } } },
    })
    expect(created.status).toBe(201)
    const inserted = await call(node, 'POST', `/indexes/${name}/documents`, {
      credential: ADMIN_KEY,
      body: { id: `${name}-1`, document: { title: `${name} trail shoes` } },
    })
    expect(inserted.status).toBeLessThan(300)
  }
  expect(
    (await call(node, 'PUT', `/indexes/${SHOP}/changes`, { credential: ADMIN_KEY, body: { enabled: true } })).status,
  ).toBeLessThan(300)
  expect(
    (await call(node, 'PUT', `/indexes/${SHOP}/query-suggestions`, { credential: ADMIN_KEY, body: SUGGESTION_SETTING }))
      .status,
  ).toBeLessThan(300)
})

afterAll(async () => {
  await node?.stop()
  removeFolder(folder)
})

function search(index: string, credential?: string) {
  return call(node, 'POST', `/indexes/${index}/search`, { credential, body: { term: 'trail' } })
}

function hitIdsOf(answer: { body: unknown }): unknown {
  const body = answer.body as { hits?: Array<{ id?: unknown }> }
  return body.hits?.map(hit => hit.id)
}

function readToken(payload: Record<string, unknown>): string {
  return signToken(READ_KEY, { exp: secondsFromNow(300), ...payload })
}

describe('the container node guards every route outside the probes', () => {
  it('answers the probes with no credential and refuses everything else with 401', async () => {
    expect((await call(node, 'GET', '/livez')).status).toBe(200)
    expect((await call(node, 'GET', '/readyz')).status).toBe(200)
    for (const answer of [
      await search(SHOP),
      await search(SHOP, OTHER_KEY),
      await call(node, 'GET', '/indexes'),
      await call(node, 'GET', '/capabilities'),
      await call(node, 'GET', `/indexes/${SHOP}/export`),
    ]) {
      expect(answer.status).toBe(401)
      expect(errorCodeOf(answer)).toBe('UNAUTHORIZED')
    }
  })

  it('lets the read key search and refuses it every write, snapshot, and export', async () => {
    const found = await search(SHOP, READ_KEY)
    expect(found.status).toBe(200)
    expect(hitIdsOf(found)).toEqual(['shop-1'])
    for (const answer of [
      await call(node, 'POST', '/indexes', { credential: READ_KEY, body: { name: 'intruder', config: {} } }),
      await call(node, 'POST', `/indexes/${SHOP}/documents`, {
        credential: READ_KEY,
        body: { id: 'planted', document: { title: 'planted' } },
      }),
      await call(node, 'DELETE', `/indexes/${SHOP}`, { credential: READ_KEY }),
      await call(node, 'GET', `/indexes/${SHOP}/snapshot`, { credential: READ_KEY }),
      await call(node, 'GET', `/indexes/${SHOP}/export`, { credential: READ_KEY }),
      await call(node, 'PUT', `/indexes/${SHOP}/changes`, { credential: READ_KEY, body: { enabled: false } }),
    ]) {
      expect(answer.status).toBe(403)
      expect(errorCodeOf(answer)).toBe('FORBIDDEN')
    }
    expect(hitIdsOf(await search(SHOP, ADMIN_KEY))).toEqual(['shop-1'])
  })

  it('keeps a token inside its indexes and inside the role of the key that signed it', async () => {
    const shopOnly = readToken({ indexes: [SHOP] })
    expect((await search(SHOP, shopOnly)).status).toBe(200)
    expect((await search(PRIVATE, shopOnly)).status).toBe(403)
    expect((await call(node, 'GET', `/indexes/${PRIVATE}/stats`, { credential: shopOnly })).status).toBe(403)
    expect((await call(node, 'GET', '/livez', { credential: shopOnly })).status).toBe(200)

    const readEverywhere = readToken({})
    expect((await search(PRIVATE, readEverywhere)).status).toBe(200)
    const write = await call(node, 'POST', `/indexes/${SHOP}/documents`, {
      credential: readEverywhere,
      body: { id: 'planted', document: { title: 'planted' } },
    })
    expect(write.status).toBe(403)

    const adminToken = signToken(ADMIN_KEY, { exp: secondsFromNow(300), indexes: [SHOP] })
    const adminWrite = await call(node, 'POST', `/indexes/${SHOP}/documents`, {
      credential: adminToken,
      body: { id: 'shop-2', document: { title: 'road shoes' } },
    })
    expect(adminWrite.status).toBeLessThan(300)
    expect((await call(node, 'DELETE', `/indexes/${PRIVATE}`, { credential: adminToken })).status).toBe(403)
  })

  it('refuses a forged, expired, early, or unsigned token with 401', async () => {
    const valid = readToken({ indexes: [SHOP] })
    const [header, , signature] = valid.split('.')
    const widened = Buffer.from(JSON.stringify({ exp: secondsFromNow(300), indexes: [PRIVATE] })).toString('base64url')
    const forged = [
      signToken(READ_KEY, { exp: secondsFromNow(300) }, { alg: 'none', typ: 'JWT' }),
      `${signToken(READ_KEY, { exp: secondsFromNow(300) }, { alg: 'none', typ: 'JWT' })
        .split('.')
        .slice(0, 2)
        .join('.')}.`,
      signToken(READ_KEY, { exp: secondsFromNow(300) }, { alg: 'HS512', typ: 'JWT' }),
      signToken(READ_KEY, { exp: secondsFromNow(-5) }),
      signToken(READ_KEY, { sub: 'no-expiry' }),
      signToken(READ_KEY, { exp: String(secondsFromNow(300)) }),
      signToken(READ_KEY, { exp: 1e308 }),
      signToken(READ_KEY, { exp: secondsFromNow(300), nbf: secondsFromNow(600) }),
      signToken(OTHER_KEY, { exp: secondsFromNow(300) }),
      `${header}.${widened}.${signature}`,
      `${valid}x`,
      'not.a.token',
    ]
    for (const token of forged) {
      const answer = await search(PRIVATE, token)
      expect({ token, status: answer.status }).toEqual({ token, status: 401 })
    }
    expect(
      (await search(SHOP, signToken(READ_KEY, { exp: secondsFromNow(300), nbf: secondsFromNow(30) }))).status,
    ).toBe(200)
  })
})

function openChangeFeed(credential: string | null): Promise<{ closed: Promise<number> }> {
  const protocols = credential === null ? [CHANGES_SUBPROTOCOL] : [CHANGES_SUBPROTOCOL, credential]
  const socket = new WebSocket(`${node.url.replace('http', 'ws')}/indexes/${SHOP}/changes/feed`, protocols)
  const closed = new Promise<number>(resolve => {
    socket.addEventListener('close', event => resolve(event.code))
  })
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ closed }))
    socket.addEventListener('error', () => reject(new Error('The change feed upgrade failed')))
  })
}

describe('a change feed opened under a token', () => {
  it('refuses an upgrade with no credential and closes with 4401 once the token expires', async () => {
    await expect(openChangeFeed(null)).rejects.toThrow('upgrade failed')
    await expect(openChangeFeed(readToken({ indexes: [PRIVATE] }))).rejects.toThrow('upgrade failed')
    const feed = await openChangeFeed(signToken(READ_KEY, { exp: secondsFromNow(2), indexes: [SHOP] }))
    expect(await feed.closed).toBe(CREDENTIAL_EXPIRED_CLOSE_CODE)
  })
})

function record(credential: string, headers: Record<string, string> = {}) {
  return call(node, 'POST', `/indexes/${SHOP}/query-suggestions/record`, {
    credential,
    headers,
    body: { query: 'trail shoes' },
  })
}

function outcomeOf(answer: { body: unknown }): unknown {
  return (answer.body as { outcome?: unknown }).outcome
}

describe('query suggestions count a person only from a credential that vouches for them', () => {
  it('trusts the person headers from the admin key and the claims of a token', async () => {
    expect(outcomeOf(await record(ADMIN_KEY, { 'narsil-person': 'person-1', 'narsil-group': 'shoppers' }))).toBe(
      'recorded',
    )
    expect(outcomeOf(await record(readToken({ sub: 'person-2', group: 'shoppers' })))).toBe('recorded')
  })

  it('counts nothing for the read key, for a token without claims, or for a malformed person or group', async () => {
    const spoofed = await record(READ_KEY, { 'narsil-person': 'person-3', 'narsil-group': 'shoppers' })
    expect(spoofed.status).toBe(200)
    expect(outcomeOf(spoofed)).toBe('unidentified')
    const ignoredHeaders = await record(readToken({}), { 'narsil-person': 'person-4', 'narsil-group': 'shoppers' })
    expect(outcomeOf(ignoredHeaders)).toBe('unidentified')
    for (const claims of [
      { sub: 'person-5' },
      { sub: 'person-5', group: 'not a group' },
      { sub: 'p'.repeat(257), group: 'shoppers' },
      { sub: '', group: 'shoppers' },
    ]) {
      const answer = await record(readToken(claims))
      expect({ claims, status: answer.status, outcome: outcomeOf(answer) }).toEqual({
        claims,
        status: 200,
        outcome: 'unidentified',
      })
    }
    const status = await call(node, 'GET', `/indexes/${SHOP}/query-suggestions/preview`, { credential: ADMIN_KEY })
    const entries = (status.body as { entries?: unknown[] }).entries ?? []
    expect(entries).toEqual([{ query: 'trail shoes', group: 'shoppers', count: 2 }])
  })
})
