import { describe, expect, it } from 'vitest'
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
  it.each([
    ['an endpoint without a scheme', ['etcd.internal:2379']],
    ['one plain endpoint among secure ones', ['https://etcd-a.internal:2379', 'http://etcd-b.internal:2379']],
  ])('refuses tls alongside %s', async (_label, endpoints) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints, tls: { ca: AUTHORITY } }))).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.each([
    ['a remote http endpoint', ['http://10.0.4.7:2379']],
    ['a host that only starts like a loopback name', ['http://localhost.example.com:2379']],
    ['one remote endpoint among loopback ones', ['http://127.0.0.1:2379', 'http://10.0.4.7:2379']],
  ])('refuses a password sent in clear text to %s', async (_label, endpoints) => {
    expect(await codeOf(createEtcdCoordinator({ endpoints, auth: AUTH }))).toBe(ErrorCodes.CONFIG_INVALID)
  })
})
