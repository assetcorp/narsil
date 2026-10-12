import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import { ErrorCodes, NarsilError } from '../../../../errors'
import type { SchemaDefinition } from '../../../../types/schema'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'

const ETCD_DEFAULT_MAX_REQUEST_BYTES = 1_572_864
const ETCD_GRPC_OVERHEAD_BYTES = 524_288
const REQUEST_FRAMING_BYTES = 1_024
const EIGHT_MIB = 8_388_608
const SIX_MIB = 6_291_456
const KEY = 'bootstrap-record'

function patternedBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let position = 0; position < length; position++) {
    bytes[position] = (position * 31 + seed) & 0xff
  }
  return bytes
}

function etcdKeyBytes(keyPrefix: string, key: string): number {
  return Buffer.byteLength(`${keyPrefix}/kv/${key}`)
}

async function refusalOf(action: Promise<unknown>): Promise<NarsilError> {
  try {
    await action
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('The write succeeded where a refusal was expected')
}

function expectSameBytes(actual: Uint8Array | null, expected: Uint8Array): void {
  if (actual === null) throw new Error('The stored value is missing')
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0)
}

describe('EtcdCoordinator integration - request size', () => {
  let container: EtcdContainerHandle | null = null
  const coordinators: ClusterCoordinator[] = []

  async function coordinatorFor(
    endpoint: string,
    maxRequestBytes?: number,
  ): Promise<{ coordinator: ClusterCoordinator; keyPrefix: string }> {
    const keyPrefix = `_narsil_size_${randomUUID()}`
    const coordinator = await createEtcdCoordinator({
      endpoints: [endpoint],
      keyPrefix,
      ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    })
    coordinators.push(coordinator)
    return { coordinator, keyPrefix }
  }

  function endpoint(): string {
    if (container === null) throw new Error('Etcd integration container is not available')
    return container.endpoint
  }

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
      return
    }

    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map(coordinator => coordinator.shutdown()))
  })

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 30_000)

  it('stores the largest value that fits the default limit and refuses one byte more before sending it', async () => {
    const { coordinator, keyPrefix } = await coordinatorFor(endpoint())
    const largest = ETCD_DEFAULT_MAX_REQUEST_BYTES - REQUEST_FRAMING_BYTES - 2 * etcdKeyBytes(keyPrefix, KEY)

    const tooLarge = await refusalOf(coordinator.compareAndSet(KEY, null, patternedBytes(largest + 1, 7)))
    expect(tooLarge.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(tooLarge.message).toContain('maxRequestBytes of 1572864')
    expect(tooLarge.details).toMatchObject({ bytes: ETCD_DEFAULT_MAX_REQUEST_BYTES + 1 })
    expect(await coordinator.get(KEY)).toBeNull()

    const value = patternedBytes(largest, 3)
    expect(await coordinator.compareAndSet(KEY, null, value)).toBe(true)
    expectSameBytes(await coordinator.get(KEY), value)
  }, 60_000)

  it('counts the expected value of a compare-and-set against the limit', async () => {
    const { coordinator, keyPrefix } = await coordinatorFor(endpoint())
    const keyBytes = etcdKeyBytes(keyPrefix, KEY)
    const first = patternedBytes(600_000, 1)
    expect(await coordinator.compareAndSet(KEY, null, first)).toBe(true)

    const room = ETCD_DEFAULT_MAX_REQUEST_BYTES - REQUEST_FRAMING_BYTES - 2 * keyBytes - first.byteLength
    const refused = await refusalOf(coordinator.compareAndSet(KEY, first, patternedBytes(room + 1, 2)))
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expectSameBytes(await coordinator.get(KEY), first)

    const second = patternedBytes(room, 2)
    expect(await coordinator.compareAndSet(KEY, first, second)).toBe(true)
    expectSameBytes(await coordinator.get(KEY), second)
  }, 60_000)

  it('refuses an oversized schema and leaves no schema behind', async () => {
    const { coordinator } = await coordinatorFor(endpoint())
    const schema: SchemaDefinition = {}
    for (let field = 0; field < 40_000; field++) {
      schema[`field_${String(field).padStart(5, '0')}_${'x'.repeat(24)}`] = 'string'
    }

    const refused = await refusalOf(coordinator.putSchema('wide', schema))
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(await coordinator.getSchema('wide')).toBeNull()
    expect(await coordinator.listSchemas()).toEqual([])
  }, 60_000)

  it('turns the etcd refusal of a request above its limit into CONFIG_INVALID and keeps serving', async () => {
    const { coordinator } = await coordinatorFor(endpoint(), EIGHT_MIB)

    const refused = await refusalOf(coordinator.compareAndSet('over-etcd', null, patternedBytes(1_600_000, 5)))
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(refused.message).toContain('etcd reports')
    expect(await coordinator.get('over-etcd')).toBeNull()
    expect(await coordinator.compareAndSet('after', null, patternedBytes(16, 1))).toBe(true)
  }, 60_000)

  it('turns the gRPC refusal of a request far above the etcd limit into CONFIG_INVALID and serves again once etcd3 reopens its circuit', async () => {
    const { coordinator } = await coordinatorFor(endpoint(), EIGHT_MIB)

    const overGrpc = ETCD_DEFAULT_MAX_REQUEST_BYTES + ETCD_GRPC_OVERHEAD_BYTES + 1
    const refused = await refusalOf(coordinator.compareAndSet('over-grpc', null, patternedBytes(overGrpc, 6)))
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(refused.message).toContain('etcd reports')

    await eventually(
      async () => {
        expect(await coordinator.get('over-grpc')).toBeNull()
      },
      15_000,
      'The coordinator did not serve again after the gRPC refusal',
    )
  }, 60_000)

  it.each([
    ['the framing size', 1_024],
    ['a fraction', 1_572_864.5],
    ['past the gRPC message limit', 2_147_483_648],
    ['not a number', Number.NaN],
    ['negative', -1],
  ])('refuses a maxRequestBytes that is %s', async (_label, maxRequestBytes) => {
    const refused = await refusalOf(createEtcdCoordinator({ endpoints: [endpoint()], maxRequestBytes }))
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.skipIf(MANAGED_ETCD_ENDPOINT !== null)(
    'stores and reads back a value larger than the default gRPC receive limit',
    async () => {
      const large = await startEtcdContainer(['--max-request-bytes', String(EIGHT_MIB)])
      try {
        const { coordinator } = await coordinatorFor(large.endpoint, EIGHT_MIB)
        const value = patternedBytes(SIX_MIB, 9)
        expect(await coordinator.compareAndSet(KEY, null, value)).toBe(true)
        expectSameBytes(await coordinator.get(KEY), value)
      } finally {
        await Promise.all(coordinators.splice(0).map(coordinator => coordinator.shutdown()))
        await stopEtcdContainer(large.name)
      }
    },
    120_000,
  )
})
