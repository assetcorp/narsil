import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJson, postJson, startTestServer, type TestServer } from './helpers'

const SCHEMA = { docId: 'string', text: 'string' }

const DOC_COUNT = 2000
const TEXT_CHARS_PER_DOC = 2_400

interface Doc {
  id: string
  docId: string
  text: string
}

function buildText(id: string, charTarget: number): string {
  const segments: string[] = []
  let length = 0
  let position = 0
  while (length < charTarget) {
    const segment = `${id}:seg${position}:${id.split('').reverse().join('')};`
    segments.push(segment)
    length += segment.length
    position++
  }
  return segments.join('').slice(0, charTarget)
}

function buildCorpus(count: number, charTarget: number): Doc[] {
  const documents: Doc[] = []
  for (let i = 0; i < count; i++) {
    const id = `doc-${i.toString().padStart(6, '0')}`
    documents.push({ id, docId: id, text: buildText(id, charTarget) })
  }
  return documents
}

interface RawResponse {
  statusCode: number
  contentType: string
  body: Buffer
}

function parseHead(head: string): { statusCode: number; contentType: string; contentLength: number } {
  const lines = head.split('\r\n')
  const statusCode = Number.parseInt(lines[0].split(' ')[1] ?? '', 10)
  let contentType = ''
  let contentLength = -1
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'content-type') contentType = value
    else if (key === 'content-length') contentLength = Number.parseInt(value, 10)
  }
  return { statusCode, contentType, contentLength }
}

/**
 * Issues one HTTP/1.1 request over a raw socket and drains the response at a
 * throttled rate, holding the socket in paused mode and pulling a bounded slice
 * per tick. A reader this slow leaves the server's send buffer full, which forces
 * the streamed sender through its backpressure path (tryEnd returning false, then
 * resuming from the acknowledged offset in onWritable). The full body is
 * reassembled and returned so a caller can assert it survived intact.
 */
function slowRequest(
  host: string,
  port: number,
  raw: string,
  opts: { chunkBytes: number; intervalMs: number; timeoutMs: number },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    const chunks: Buffer[] = []
    let received = 0
    let head: { statusCode: number; contentType: string; contentLength: number } | null = null
    let headEnd = -1
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) clearInterval(timer)
      timer = null
      socket.destroy()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const finish = (): void => {
      if (settled) return
      const buffer = Buffer.concat(chunks)
      const parsed = head
      if (!parsed) {
        fail(new Error('response ended before headers were received'))
        return
      }
      settled = true
      cleanup()
      resolve({ statusCode: parsed.statusCode, contentType: parsed.contentType, body: buffer.subarray(headEnd) })
    }

    const absorb = (piece: Buffer): void => {
      chunks.push(piece)
      received += piece.byteLength
      if (!head) {
        const joined = Buffer.concat(chunks)
        const sep = joined.indexOf('\r\n\r\n')
        if (sep !== -1) {
          head = parseHead(joined.toString('latin1', 0, sep))
          headEnd = sep + 4
        }
      }
      if (head && head.contentLength >= 0 && received - headEnd >= head.contentLength) finish()
    }

    socket.on('error', fail)
    socket.on('connect', () => {
      socket.write(raw)
      socket.pause()
      timer = setInterval(() => {
        const piece = (socket.read(opts.chunkBytes) ?? socket.read()) as Buffer | null
        if (piece) absorb(piece)
      }, opts.intervalMs)
    })
    socket.on('end', () => {
      let piece = socket.read() as Buffer | null
      while (piece) {
        absorb(piece)
        piece = socket.read() as Buffer | null
      }
      finish()
    })
    setTimeout(() => fail(new Error('slow reader timed out')), opts.timeoutMs)
  })
}

async function seedCorpus(base: string, documents: Doc[]): Promise<void> {
  const created = await postJson(base, '/indexes', { name: 'articles', config: { schema: SCHEMA } })
  expect(created.status).toBe(201)
  const batch = await postJson<{ succeeded: string[]; failed: unknown[] }>(base, '/indexes/articles/documents/_batch', {
    action: 'insert',
    documents,
  })
  expect(batch.status).toBe(200)
  expect(batch.body.failed).toHaveLength(0)
}

describe('a slow reader cannot force unbounded native buffering of a large response', () => {
  let srv: TestServer
  let host: string
  let port: number

  beforeEach(async () => {
    srv = await startTestServer()
    const url = new URL(srv.base)
    host = url.hostname
    port = Number.parseInt(url.port, 10)
    await seedCorpus(srv.base, buildCorpus(DOC_COUNT, TEXT_CHARS_PER_DOC))
  })

  afterEach(async () => {
    await srv.stop()
  })

  it('streams a multi-megabyte binary snapshot to a throttled reader byte-for-byte', async () => {
    const baseline = Buffer.from(await (await fetch(`${srv.base}/indexes/articles/snapshot`)).arrayBuffer())
    expect(baseline.byteLength).toBeGreaterThan(2 * 1024 * 1024)

    const raw = `GET /indexes/articles/snapshot HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`
    const response = await slowRequest(host, port, raw, { chunkBytes: 16 * 1024, intervalMs: 20, timeoutMs: 30_000 })

    expect(response.statusCode).toBe(200)
    expect(response.contentType).toBe('application/octet-stream')
    expect(response.body.byteLength).toBe(baseline.byteLength)
    expect(response.body.equals(baseline)).toBe(true)
  }, 45_000)

  it('streams a large JSON multi-get body to a throttled reader without loss', async () => {
    const docIds = buildCorpus(DOC_COUNT, TEXT_CHARS_PER_DOC).map(d => d.id)
    const payload = JSON.stringify({ docIds })
    const raw =
      `POST /indexes/articles/documents/_multi-get HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      `Connection: close\r\n\r\n${payload}`

    const response = await slowRequest(host, port, raw, { chunkBytes: 16 * 1024, intervalMs: 20, timeoutMs: 30_000 })

    expect(response.statusCode).toBe(200)
    expect(response.contentType).toBe('application/json')
    expect(response.body.byteLength).toBeGreaterThan(64 * 1024)
    const parsed = JSON.parse(response.body.toString('utf8')) as { documents: Record<string, Doc> }
    expect(Object.keys(parsed.documents)).toHaveLength(DOC_COUNT)
    expect(parsed.documents['doc-000000'].text).toBe(buildText('doc-000000', TEXT_CHARS_PER_DOC))
    expect(parsed.documents[`doc-${(DOC_COUNT - 1).toString().padStart(6, '0')}`]).toBeDefined()
  }, 45_000)

  it('still serves the same large snapshot correctly to a fast reader', async () => {
    const first = Buffer.from(await (await fetch(`${srv.base}/indexes/articles/snapshot`)).arrayBuffer())
    const second = Buffer.from(await (await fetch(`${srv.base}/indexes/articles/snapshot`)).arrayBuffer())
    expect(first.equals(second)).toBe(true)

    const count = await getJson<{ count: number }>(srv.base, '/indexes/articles/count')
    expect(count.body.count).toBe(DOC_COUNT)
  }, 30_000)
})
