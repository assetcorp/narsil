import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, call, removeFolder, startNode, temporaryFolder } from './support/node'

it('refuses an import whose accepted task cannot reach disk and releases its task slot', async () => {
  const folder = temporaryFolder('task-write-failure')
  const node = await startNode({
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_DATA_DIR: folder,
    NARSIL_LIMIT_MAX_CONCURRENT_TASKS: '1',
  })
  try {
    expect(
      (
        await call(node, 'POST', '/indexes', {
          credential: ADMIN_KEY,
          body: { name: 'books', config: { schema: { title: 'string' } } },
        })
      ).status,
    ).toBe(201)
    const tasks = join(folder, 'tasks')
    await rm(tasks, { recursive: true })
    await writeFile(tasks, 'unwritable task folder')
    const refused = await call(node, 'POST', '/indexes/books/documents/_import?async=true', {
      credential: ADMIN_KEY,
      raw: '{"id":"one","title":"garden"}\n',
    })
    expect(refused.status).toBe(500)
    expect((await call(node, 'GET', '/indexes/books/count', { credential: ADMIN_KEY })).body).toEqual({ count: 0 })
    await rm(tasks)
    await mkdir(tasks)
    const accepted = await call(node, 'POST', '/indexes/books/documents/_import?async=true', {
      credential: ADMIN_KEY,
      raw: '{"id":"one","title":"garden"}\n',
    })
    expect(accepted.status).toBe(202)
    const id = (accepted.body as { id: string }).id
    await expect
      .poll(async () => (await call(node, 'GET', `/tasks/${id}`, { credential: ADMIN_KEY })).body)
      .toMatchObject({ status: 'succeeded' })
  } finally {
    await node.stop()
    removeFolder(folder)
  }
})
