import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers, startEtcdMembers } from './etcd-members'

const FAILED_CALLS_WHILE_DOWN = 4
const PAST_THE_ENDPOINT_COOL_DOWN_MS = 6_000
const ANSWER_WITHIN_MS = 20_000

async function outcomeWithin(work: Promise<unknown>, limitMs: number): Promise<string> {
  const settled = work.then(
    () => 'answered',
    (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  return Promise.race([settled, delay(limitMs, 'still pending', { ref: false })])
}

describe.skipIf(process.env.NARSIL_FAULT_PLAIN === '1')('an etcd coordinator whose only endpoint restarts', () => {
  let bundles: TlsBundles
  let etcd: EtcdMembers | null = null
  let coordinator: ClusterCoordinator | null = null

  beforeAll(async () => {
    bundles = await generateTlsBundles()
    etcd = await startEtcdMembers(bundles)
  }, 240_000)

  afterAll(async () => {
    await coordinator?.shutdown().catch(() => {})
    await etcd?.remove()
  }, 120_000)

  it('answers again once the endpoint is back, after calls failed while it was down and etcd revoked its token', async () => {
    if (etcd === null) throw new Error('etcd did not start')
    const endpoint = etcd.endpoints[0]
    if (endpoint === undefined) throw new Error('etcd started with no endpoint')
    coordinator = await createEtcdCoordinator({
      endpoints: [endpoint],
      keyPrefix: `_narsil_endpoint_restart_${randomUUID()}`,
      tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
      auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
    })
    expect(await outcomeWithin(coordinator.listNodes(), ANSWER_WITHIN_MS)).toBe('answered')

    await etcd.stop(0)
    for (let call = 0; call < FAILED_CALLS_WHILE_DOWN; call++) {
      expect(await outcomeWithin(coordinator.listNodes(), ANSWER_WITHIN_MS)).toMatch(/^failed: /)
    }
    await etcd.revokeAuthTokens(1)
    await etcd.restart(0)
    await delay(PAST_THE_ENDPOINT_COOL_DOWN_MS)

    expect(await outcomeWithin(coordinator.listNodes(), ANSWER_WITHIN_MS)).toBe('answered')
    expect(await outcomeWithin(coordinator.getAllocation('ledger'), ANSWER_WITHIN_MS)).toBe('answered')
  }, 180_000)
})
