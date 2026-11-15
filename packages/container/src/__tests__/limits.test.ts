import { afterAll, beforeAll, expect, it } from 'vitest'
import { ADMIN_KEY, call, type RunningNode, startNode } from './support/node'

let node: RunningNode

beforeAll(async () => {
  node = await startNode({
    NARSIL_STORAGE: 'memory',
    NARSIL_WORKERS: '0',
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_LIMIT_MAX_RESULT_WINDOW: '3',
    NARSIL_LIMIT_MAX_FETCH_DOCUMENTS: '3',
    NARSIL_LIMIT_MAX_TASK_PAGE_SIZE: '3',
  })
  expect(
    (
      await call(node, 'POST', '/indexes', {
        credential: ADMIN_KEY,
        body: { name: 'books', config: { schema: { title: 'string' } } },
      })
    ).status,
  ).toBe(201)
  for (let i = 0; i < 8; i++) {
    expect(
      (
        await call(node, 'POST', '/indexes/books/documents', {
          credential: ADMIN_KEY,
          body: { id: `book-${i}`, document: { title: 'garden' } },
        })
      ).status,
    ).toBe(201)
  }
})

afterAll(async () => {
  await node?.stop()
})

it('bounds omitted page sizes by the configured limits', async () => {
  const search = await call(node, 'POST', '/indexes/books/search', { credential: ADMIN_KEY, body: { term: 'garden' } })
  expect(search.status).toBe(200)
  expect((search.body as { hits: unknown[] }).hits).toHaveLength(3)
  const list = await call(node, 'POST', '/indexes/books/documents/_list', { credential: ADMIN_KEY, body: {} })
  expect(list.status).toBe(200)
  expect((list.body as { documents: unknown[] }).documents).toHaveLength(3)
  const tasks = await call(node, 'GET', '/tasks', { credential: ADMIN_KEY })
  expect(tasks.status).toBe(200)
  expect((tasks.body as { limit: number }).limit).toBe(3)
  for (const path of ['/indexes/books/search', '/indexes/books/documents/_list']) {
    expect((await call(node, 'POST', path, { credential: ADMIN_KEY, body: { limit: 4 } })).status).toBe(400)
  }
  expect((await call(node, 'GET', '/tasks?limit=4', { credential: ADMIN_KEY })).status).toBe(400)
})
