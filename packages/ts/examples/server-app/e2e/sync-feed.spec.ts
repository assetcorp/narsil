import { expect, test } from '@playwright/test'
import { feedClose, mintGrant, rawUpgrade, SYNC_SUBPROTOCOL } from './feed'
import { E2E_ORIGIN, E2E_SYNC_GRANT_MS } from './settings'

const NOTE = { title: 'Harbour inspection', body: 'Check the north pier' }

function indexPath(name: string): string {
  return `${E2E_ORIGIN}/api/narsil/indexes/${name}`
}

test('a signed browser cookie fixes the space and scopes grants despite a supplied index name', async ({ context }) => {
  const grant = await mintGrant(context.request)
  const cookies = await context.cookies()
  const cookie = cookies.find(entry => entry.name === 'narsil-notes-space')
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
  const response = await context.request.post(`${E2E_ORIGIN}/api/sync-grant`, {
    headers: { origin: E2E_ORIGIN },
    data: { indexName: 'demo-notes-11111111-1111-4111-8111-111111111111' },
  })
  expect(response.status()).toBe(200)
  expect((await response.json()).indexName).toBe(grant.indexName)
  const upload = await context.request.put(`${indexPath(grant.indexName)}/documents/note`, {
    headers: { authorization: `Bearer ${grant.credential}` },
    data: { document: NOTE },
  })
  expect(upload.ok()).toBe(true)
  const document = await context.request.get(`${indexPath(grant.indexName)}/documents/note`, {
    headers: { authorization: `Bearer ${grant.credential}` },
  })
  expect((await document.json()).document).toEqual(NOTE)
})

test('another browser cannot discover or operate on a known notes space through encoded paths or bodies', async ({
  browser,
}) => {
  const owner = await browser.newContext()
  const visitor = await browser.newContext()
  try {
    const first = await mintGrant(owner.request)
    const second = await mintGrant(visitor.request)
    expect(first.indexName).not.toBe(second.indexName)
    const list = await visitor.request.get(`${E2E_ORIGIN}/api/narsil/indexes`)
    expect((await list.json()).indexes.every((entry: { name: string }) => !entry.name.startsWith('demo-notes-'))).toBe(
      true,
    )
    const variants = [first.indexName, first.indexName.replace('demo-', 'demo%2D'), first.indexName.replace('d', '%64')]
    const routes = [
      ['GET', '/documents/note'],
      ['PUT', '/documents/note'],
      ['DELETE', ''],
      ['POST', '/documents'],
      ['POST', '/search'],
      ['GET', '/snapshot'],
      ['POST', '/restore'],
      ['POST', '/import'],
      ['POST', '/documents/_import'],
      ['POST', '/documents/_multi-get'],
      ['PUT', '/sync'],
      ['GET', '/sync/snapshot'],
      ['POST', '/copy'],
      ['PUT', '/alias'],
    ]
    for (const name of variants) {
      for (const [method, suffix] of routes) {
        const answer = await visitor.request.fetch(`${indexPath(name)}${suffix}`, {
          method,
          headers: { authorization: `Bearer ${second.credential}` },
          data: method === 'GET' ? undefined : { document: NOTE, indexName: first.indexName },
        })
        expect(answer.status(), `${method} ${name}${suffix}`).toBeGreaterThanOrEqual(400)
        expect(answer.status()).toBeLessThan(500)
      }
      const feed = await rawUpgrade(
        `/api/narsil/indexes/${name}/sync/feed`,
        [SYNC_SUBPROTOCOL, second.credential],
        second.cookie,
      )
      expect(feed.kind === 'refused' ? feed.status : 0).toBe(401)
    }
    for (const path of [
      `/indexes//${first.indexName}/documents/note`,
      `/indexes/${first.indexName}/documents/note/`,
      `/indexes/public/../${first.indexName}/documents/note`,
      `/indexes/${first.indexName}/documents/note?index=places`,
      `/indexes?indexName=${first.indexName}`,
      `/tasks?index=${first.indexName}`,
      '/search',
      '/multi-search',
      '/aliases',
      '/indexes/public/copy',
      '/backups',
      '/backups/archive/_restore',
    ]) {
      const response = await visitor.request.fetch(`${E2E_ORIGIN}/api/narsil${path}`, {
        method: 'POST',
        data: { name: first.indexName, indexName: first.indexName, indexes: [first.indexName] },
      })
      expect(response.status(), path).toBeGreaterThanOrEqual(400)
      expect(response.status(), path).toBeLessThan(500)
    }
    const create = await visitor.request.post(`${E2E_ORIGIN}/api/narsil/indexes`, {
      data: { name: first.indexName, config: { schema: { title: 'string' } } },
    })
    expect(create.status()).toBe(403)
    for (const path of [`/tasks?indexName=${first.indexName}`, `/indexes?name=${first.indexName}`]) {
      const response = await visitor.request.get(`${E2E_ORIGIN}/api/narsil${path}`)
      expect(response.status()).toBe(403)
    }
    for (const path of ['/tasks', '/stats/memory']) {
      const response = await visitor.request.get(`${E2E_ORIGIN}/api/narsil${path}`)
      expect(response.ok()).toBe(true)
      expect(await response.text()).not.toContain(first.indexName)
      expect(await response.text()).not.toContain(second.indexName)
    }
    const ask = await visitor.request.post(`${E2E_ORIGIN}/api/ask`, { data: { indexName: first.indexName } })
    expect(ask.status()).toBe(403)
    const missing = await rawUpgrade(`/api/narsil/indexes/${first.indexName}/sync/feed`, [SYNC_SUBPROTOCOL])
    expect(missing.kind === 'refused' ? missing.status : 0).toBe(401)
  } finally {
    await owner.close()
    await visitor.close()
  }
})

test('a grant cannot delete or administer its index, reach a dataset, or replace the cookie', async ({ context }) => {
  const grant = await mintGrant(context.request)
  const headers = { authorization: `Bearer ${grant.credential}` }
  for (const [method, path] of [
    ['DELETE', indexPath(grant.indexName)],
    ['DELETE', `${indexPath(grant.indexName)}/documents/note`],
    ['PUT', `${indexPath(grant.indexName)}/sync`],
    ['POST', `${indexPath(grant.indexName)}/search`],
    ['GET', `${E2E_ORIGIN}/api/narsil/indexes`],
    ['POST', `${E2E_ORIGIN}/api/narsil/indexes`],
  ]) {
    const response = await context.request.fetch(path, { method, headers, data: method === 'GET' ? undefined : {} })
    expect(response.status(), path).toBe(403)
  }
  await context.clearCookies()
  const missing = await context.request.post(`${E2E_ORIGIN}/api/sync-grant`, {
    headers: { origin: E2E_ORIGIN },
    data: { indexName: grant.indexName },
  })
  expect(missing.status()).toBe(401)
  const tampered = `${grant.cookie.slice(0, -1)}${grant.cookie.endsWith('A') ? 'B' : 'A'}`
  for (const cookie of [tampered, `narsil-notes-space=${grant.indexName.slice(11)}.forged`]) {
    const response = await context.request.post(`${E2E_ORIGIN}/api/sync-grant`, {
      headers: { origin: E2E_ORIGIN, cookie },
      data: {},
    })
    expect(response.status()).toBe(401)
  }
  for (const origin of ['https://hostile.example', 'null']) {
    const response = await context.request.post(`${E2E_ORIGIN}/api/sync-grant`, {
      headers: { origin, cookie: grant.cookie },
      data: {},
    })
    expect(response.status()).toBe(403)
  }
  const noOrigin = await context.request.post(`${E2E_ORIGIN}/api/sync-grant`, {
    headers: { cookie: grant.cookie },
    data: {},
  })
  expect(noOrigin.status()).toBe(403)
})

test('the proxy and admission hook refuse forged and expired grants on uploads, snapshot reads, and feeds', async ({
  context,
}) => {
  const grant = await mintGrant(context.request)
  const forged = `${grant.credential.slice(0, -1)}${grant.credential.endsWith('A') ? 'B' : 'A'}`
  for (const credential of ['not-a-grant', forged]) {
    const headers = { authorization: `Bearer ${credential}` }
    const snapshot = await context.request.get(`${indexPath(grant.indexName)}/sync/snapshot`, { headers })
    expect(snapshot.status()).toBe(401)
    const upload = await context.request.put(`${indexPath(grant.indexName)}/documents/note`, {
      headers,
      data: { document: NOTE },
    })
    expect(upload.status()).toBe(401)
    const feed = await rawUpgrade(
      `/api/narsil/indexes/${grant.indexName}/sync/feed`,
      [SYNC_SUBPROTOCOL, credential],
      grant.cookie,
    )
    expect(feed.kind === 'refused' ? feed.status : 0).toBe(401)
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, grant.expiresAt - Date.now()) + 100))
  const headers = { authorization: `Bearer ${grant.credential}` }
  expect((await context.request.get(`${indexPath(grant.indexName)}/sync/snapshot`, { headers })).status()).toBe(401)
  expect(
    (
      await context.request.put(`${indexPath(grant.indexName)}/documents/note`, { headers, data: { document: NOTE } })
    ).status(),
  ).toBe(401)
  const feed = await rawUpgrade(
    `/api/narsil/indexes/${grant.indexName}/sync/feed`,
    [SYNC_SUBPROTOCOL, grant.credential],
    grant.cookie,
  )
  expect(feed.kind === 'refused' ? feed.status : 0).toBe(401)
})

test('a current feed closes at credential expiry and a snapshot supports a scoped range read', async ({
  page,
  context,
}) => {
  const grant = await mintGrant(context.request)
  await page.goto(`${E2E_ORIGIN}/api/narsil/health`)
  const closed = await feedClose(page, grant.indexName, grant.credential)
  expect(closed.code).toBe(4401)
  expect(Date.now()).toBeGreaterThanOrEqual(grant.expiresAt)
  expect(closed.openMs).toBeLessThanOrEqual(E2E_SYNC_GRANT_MS + 1_000)
  const fresh = await mintGrant(context.request)
  const snapshot = await context.request.get(`${indexPath(fresh.indexName)}/sync/snapshot`, {
    headers: { authorization: `Bearer ${fresh.credential}`, range: 'bytes=0-7' },
  })
  expect(snapshot.status()).toBe(206)
  expect((await snapshot.body()).byteLength).toBe(8)
})
