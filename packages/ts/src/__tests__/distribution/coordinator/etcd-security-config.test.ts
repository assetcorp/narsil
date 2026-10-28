import { createServer } from 'node:net'
import { beforeAll, describe, expect, it } from 'vitest'
import { createEtcdCoordinator } from '../../../distribution/coordinator'
import { ErrorCodes, NarsilError } from '../../../errors'

const AUTHORITY = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
const AUTH = { username: 'narsil', password: 'orchard-key' }

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  throw new Error('expected the call to fail')
}

describe('etcd coordinator security settings', () => {
  let closedPort = 0

  beforeAll(async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    const address = holder.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    closedPort = address.port
    await new Promise<void>(resolve => holder.close(() => resolve()))
  })

  it.each([
    ['a client certificate without its key', { tls: { ca: AUTHORITY, cert: AUTHORITY } }],
    ['a key without its client certificate', { tls: { ca: AUTHORITY, key: AUTHORITY } }],
  ])('refuses %s', async (_label, settings) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints: ['https://etcd.internal:2379'], ...settings }))).toBe(
      ErrorCodes.CONFIG_INVALID,
    )
  })

  it.each([
    ['an http endpoint', ['http://etcd.internal:2379']],
    ['an endpoint without a scheme', ['etcd.internal:2379']],
    ['one plain endpoint among secure ones', ['https://etcd-a.internal:2379', 'http://etcd-b.internal:2379']],
  ])('refuses tls alongside %s', async (_label, endpoints) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints, tls: { ca: AUTHORITY } }))).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.each([
    ['a remote http endpoint', ['http://10.0.4.7:2379']],
    ['a remote name without a scheme', ['etcd.internal:2379']],
    ['a host that only starts like a loopback name', ['http://localhost.example.com:2379']],
    ['a host that only starts like a loopback address', ['http://127.0.0.1.example.com:2379']],
    ['one remote endpoint among loopback ones', ['http://127.0.0.1:2379', 'http://10.0.4.7:2379']],
  ])('refuses a password sent in clear text to %s', async (_label, endpoints) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints, auth: AUTH }))).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.each([
    ['an empty user name', { username: '', password: 'orchard-key' }],
    ['an empty password', { username: 'narsil', password: '' }],
  ])('refuses %s', async (_label, auth) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints: ['https://etcd.internal:2379'], auth }))).toBe(
      ErrorCodes.CONFIG_INVALID,
    )
  })

  it.each([
    ['127.0.0.1', (port: number) => `http://127.0.0.1:${port}`],
    ['localhost', (port: number) => `http://localhost:${port}`],
    ['127.0.0.1 without a scheme', (port: number) => `127.0.0.1:${port}`],
  ])(
    'accepts a password over plain http to %s, and reports an etcd that nobody can reach',
    async (_label, url) => {
      expect(await codeOf(createEtcdCoordinator({ endpoints: [url(closedPort)], auth: AUTH }))).toBe(
        ErrorCodes.COORDINATOR_UNAVAILABLE,
      )
    },
    30_000,
  )
})
