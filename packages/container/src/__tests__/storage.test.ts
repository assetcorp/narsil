import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ADMIN_KEY,
  call,
  type Env,
  type RunningNode,
  removeFolder,
  runToExit,
  startNode,
  temporaryFolder,
} from './support/node'

const folders: string[] = []
const running: RunningNode[] = []

afterAll(async () => {
  for (const node of running.splice(0)) await node.stop()
  for (const folder of folders.splice(0)) removeFolder(folder)
})

function dataFolder(prefix: string): string {
  const folder = temporaryFolder(prefix)
  folders.push(folder)
  return folder
}

async function start(env: Env): Promise<RunningNode> {
  const node = await startNode({ NARSIL_ADMIN_KEY: ADMIN_KEY, NARSIL_WORKERS: '0', ...env })
  running.push(node)
  return node
}

async function stopCleanly(node: RunningNode): Promise<void> {
  running.splice(running.indexOf(node), 1)
  expect((await node.stop()).code).toBe(0)
}

async function createIndex(node: RunningNode, name: string, config: Record<string, unknown>): Promise<void> {
  const answer = await call(node, 'POST', '/indexes', { credential: ADMIN_KEY, body: { name, config } })
  expect(answer.status).toBe(201)
}

async function searchIds(node: RunningNode, index: string, term: string): Promise<unknown> {
  const answer = await call(node, 'POST', `/indexes/${index}/search`, { credential: ADMIN_KEY, body: { term } })
  expect(answer.status).toBe(200)
  return (answer.body as { hits: Array<{ id: unknown }> }).hits.map(hit => hit.id).sort()
}

async function finishedTask(node: RunningNode, id: string): Promise<{ status: string }> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const answer = await call(node, 'GET', `/tasks/${encodeURIComponent(id)}`, { credential: ADMIN_KEY })
    expect(answer.status).toBe(200)
    const record = answer.body as { status: string }
    if (record.status !== 'enqueued' && record.status !== 'running') return record
    if (Date.now() > deadline) throw new Error(`Task ${id} did not finish within 30 s`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('the data folder across a restart', () => {
  it('ignores symbolic links and oversized records without exposing files outside the task folder', async () => {
    const folder = dataFolder('planted-records')
    const tasks = join(folder, 'tasks')
    const hooks = join(folder, 'webhooks')
    mkdirSync(tasks)
    mkdirSync(hooks)
    const privateFile = join(folder, 'private.json')
    writeFileSync(
      privateFile,
      JSON.stringify({
        id: 'private',
        type: 'import',
        status: 'succeeded',
        indexName: 'books',
        owner: 'previous-node',
        createdAt: 1,
        error: { message: 'private account credential' },
      }),
    )
    symlinkSync(privateFile, join(tasks, 'private.json'))
    for (const directory of [tasks, hooks]) {
      const file = openSync(join(directory, 'oversized.json'), 'w')
      ftruncateSync(file, 1024 * 1024 * 1024)
      closeSync(file)
    }
    const node = await start({
      NARSIL_DATA_DIR: folder,
      NARSIL_WEBHOOK_URL: 'http://127.0.0.1:9/events',
      NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
    })
    const answer = await call(node, 'GET', '/tasks/private', { credential: ADMIN_KEY })
    expect(answer.status).toBe(404)
    expect(JSON.stringify(await call(node, 'GET', '/tasks', { credential: ADMIN_KEY }))).not.toContain(
      'private account',
    )
    expect((await call(node, 'GET', '/readyz')).status).toBe(200)
    await stopCleanly(node)
  })

  it('keeps the documents and the task records, and skips junk that a person left in tasks/', async () => {
    const folder = dataFolder('restart')
    const first = await start({ NARSIL_DATA_DIR: folder })
    await createIndex(first, 'books', { schema: { title: 'string' } })
    const lines = ['{"id":"b1","title":"winter garden"}', '{"id":"b2","title":"summer garden"}']
    const started = await call(first, 'POST', '/indexes/books/documents/_import?async=true', {
      credential: ADMIN_KEY,
      headers: { 'content-type': 'application/x-ndjson' },
      raw: `${lines.join('\n')}\n`,
    })
    expect(started.status).toBe(202)
    const taskId = (started.body as { id: string }).id
    expect((await finishedTask(first, taskId)).status).toBe('succeeded')
    expect(await first.waitForStdout(line => line.includes('"task.finished"'))).toContain(taskId)
    await stopCleanly(first)

    const tasks = join(folder, 'tasks')
    writeFileSync(join(tasks, 'broken.json'), '{"id":')
    writeFileSync(
      join(tasks, 'forged.json'),
      JSON.stringify({ id: 'someone-else', type: 'import', status: 'succeeded', indexName: 'books' }),
    )

    const second = await start({ NARSIL_DATA_DIR: folder })
    expect(await searchIds(second, 'books', 'garden')).toEqual(['b1', 'b2'])
    const kept = await call(second, 'GET', `/tasks/${encodeURIComponent(taskId)}`, { credential: ADMIN_KEY })
    expect(kept.status).toBe(200)
    expect((kept.body as { status: string }).status).toBe('succeeded')
    const listed = await call(second, 'GET', '/tasks', { credential: ADMIN_KEY })
    expect(listed.status).toBe(200)
    const ids = (listed.body as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)
    expect(ids).toEqual([taskId])
    expect(readdirSync(tasks).sort()).toEqual([`${encodeURIComponent(taskId)}.json`])
    await stopCleanly(second)
  })

  it('exits 1 naming the index and the language when a saved index needs a language that is no longer loaded', async () => {
    const folder = dataFolder('language')
    const first = await start({ NARSIL_DATA_DIR: folder, NARSIL_LANGUAGES: 'english,french' })
    await createIndex(first, 'menu', { schema: { dish: 'string' }, language: 'french' })
    await stopCleanly(first)

    const exit = await runToExit({ NARSIL_DATA_DIR: folder, NARSIL_ADMIN_KEY: ADMIN_KEY, NARSIL_WORKERS: '0' })
    expect(exit.code).toBe(1)
    const lines = exit.stderr.split('\n').filter(line => line.length > 0 && !line.startsWith('Warning:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('NARSIL_LANGUAGES')
    expect(lines[0]).toContain('french')
    expect(lines[0]).toContain('menu')
  })
})

describe('a language that only NARSIL_LANGUAGES loads', () => {
  it('reaches the worker copies, which stem French searches the way the main copy does', async () => {
    const node = await start({
      NARSIL_STORAGE: 'memory',
      NARSIL_LANGUAGES: 'english,french',
      NARSIL_WORKERS: '2',
      NARSIL_PROMOTION_THRESHOLD: '1',
    })
    await createIndex(node, 'boutique', { schema: { nom: 'string' }, language: 'french' })
    for (const [id, nom] of [
      ['p1', 'chaussures de randonnée'],
      ['p2', 'chaussettes en laine'],
    ]) {
      const answer = await call(node, 'POST', '/indexes/boutique/documents', {
        credential: ADMIN_KEY,
        body: { id, document: { nom } },
      })
      expect(answer.status).toBe(201)
    }
    const promoted = await node.waitForStdout(line => line.includes('"engine.workerPromote"'))
    expect(JSON.parse(promoted).data.reason).toContain('boutique')
    expect(await searchIds(node, 'boutique', 'chaussure')).toEqual(['p1'])
    expect(node.stdoutLines().some(line => line.includes('"engine.workerPromoteFailure"'))).toBe(false)
    expect(node.stdoutLines().some(line => line.includes('"engine.workerCrash"'))).toBe(false)
    await stopCleanly(node)
  })
})
