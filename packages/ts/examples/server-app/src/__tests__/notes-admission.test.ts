import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsil } from '@delali/narsil'
import { createNarsilClient } from '@delali/narsil/client'
import { createServer } from '@delali/narsil/server'
import { expect, test } from 'vitest'
import { admissionHook } from '../../demo-server-access'

const SECRET = 'notes-admission-secret-with-at-least-32-characters'
const ADMIN = 'notes-admission-administrator'
const NOTES = 'demo-notes-11111111-1111-4111-8111-111111111111'
const OTHER = 'demo-notes-22222222-2222-4222-8222-222222222222'
const DOCUMENT = { title: 'Harbour inspection', body: 'Check the north pier' }

function credential(indexName: string, expiresAt: number): string {
  const nonce = 'independent-test-nonce'
  const signature = createHmac('sha256', SECRET).update(`v1\n${indexName}\n${expiresAt}\n${nonce}`).digest('base64url')
  return ['v1', Buffer.from(indexName).toString('base64url'), String(expiresAt), nonce, signature].join('.')
}

function request(
  port: number,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text)),
    }
    if (token !== null) headers.authorization = `Bearer ${token}`
    const sent = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
      let received = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        received += chunk
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: received }))
    })
    sent.on('error', reject)
    sent.end(text)
  })
}

test('the real search server admits only scoped notes reads and uploads under independently signed grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-admission-'))
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory, mode: 'sync' } })
  const server = createServer(engine, {
    host: '127.0.0.1',
    port: 0,
    sync: true,
    onRequest: admissionHook(ADMIN, SECRET),
  })
  await server.listen()
  const admin = createNarsilClient({ url: `http://127.0.0.1:${server.listeningPort}`, apiKey: ADMIN })
  try {
    for (const name of [NOTES, OTHER, 'places']) {
      await admin.createIndex(name, { schema: { title: 'string', body: 'string' } })
      await admin.updateSync(name, { enabled: true })
    }
    const grant = credential(NOTES, Date.now() + 60_000)
    const port = server.listeningPort
    const uploaded = await request(port, 'PUT', `/indexes/${NOTES}/documents/note`, grant, { document: DOCUMENT })
    expect(uploaded.status).toBe(201)
    for (const name of [NOTES, NOTES.replace('demo-', 'demo%2D'), NOTES.replace('d', '%64')]) {
      const found = await request(port, 'GET', `/indexes/${name}/documents/note`, grant)
      expect(found.status).toBe(200)
      expect(JSON.parse(found.text).document).toEqual(DOCUMENT)
      for (const method of ['GET', 'PUT']) {
        for (const token of [
          null,
          'forged',
          credential(NOTES, Date.now() - 1),
          credential(OTHER, Date.now() + 60_000),
        ]) {
          const answer = await request(
            port,
            method,
            `/indexes/${name}/documents/note`,
            token,
            method === 'PUT' ? { document: DOCUMENT } : undefined,
          )
          expect(answer.status).toBe(401)
        }
      }
    }
    for (const [method, path] of [
      ['DELETE', `/indexes/${NOTES}`],
      ['POST', `/indexes/${NOTES}/search`],
      ['DELETE', `/indexes/${NOTES}/documents/note`],
      ['PUT', `/indexes/${NOTES}/sync`],
      ['GET', `/indexes/${OTHER}/documents/note`],
      ['GET', '/indexes'],
      ['POST', '/indexes'],
      ['POST', '/multi-search'],
      ['POST', '/aliases'],
      ['POST', '/indexes/places/copy'],
      ['GET', `/tasks?indexName=${NOTES}`],
      ['POST', `/indexes/${NOTES}/documents/_import`],
      ['POST', `/indexes/${NOTES}/restore`],
      ['POST', '/backups/archive/_restore'],
      ['GET', `/indexes//${NOTES}/documents/note`],
      ['GET', `/indexes/${NOTES}/documents/note/`],
      ['GET', `/indexes/places/../${NOTES}/documents/note`],
    ]) {
      const answer = await request(
        port,
        method,
        path,
        grant,
        method === 'POST' || method === 'PUT' ? { name: NOTES, indexName: NOTES } : undefined,
      )
      expect(answer.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
      expect(answer.status).toBeLessThan(500)
    }
    expect(await admin.get(NOTES, 'note')).toEqual(DOCUMENT)
    expect(await admin.countDocuments(NOTES)).toBe(1)
    expect(await admin.countDocuments(OTHER)).toBe(0)
  } finally {
    await server.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
