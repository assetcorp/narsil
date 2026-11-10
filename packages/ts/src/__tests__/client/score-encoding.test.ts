import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'

describe('score decoding through HTTP', () => {
  let server: Server | undefined
  let body = ''

  afterEach(async () => {
    const listening = server
    server = undefined
    if (listening === undefined) return
    listening.closeAllConnections()
    await new Promise<void>((resolve, reject) => listening.close(error => (error ? reject(error) : resolve())))
  })

  async function client() {
    server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('The HTTP server has no port')
    return createNarsilClient({ url: `http://127.0.0.1:${address.port}` })
  }

  it('rejects malformed and overflowing scores in both response locations', async () => {
    const search = await client()
    const malformed = ['null', 'true', '{}', '[]', '"nan"', '"1"', '"+Infinity"', '1e999']
    for (const [position, score] of malformed.entries()) {
      const hit = `{"id":"product","document":{},"score":${score}}`
      body = position % 2 === 0 ? `{"hits":[${hit}]}` : `{"hits":[],"groups":[{"values":{},"hits":[${hit}]}]}`
      await expect(search.query('products', {})).rejects.toMatchObject({ code: 'CLIENT_INVALID_RESPONSE' })
    }
  })
})
