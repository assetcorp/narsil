import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../../distribution/coordinator'
import type { EtcdCoordinatorConfig } from '../../../../distribution/coordinator/etcd/types'
import { ErrorCodes, NarsilError } from '../../../../errors'
import { generateTlsBundles, type TlsBundles } from '../../transport/tcp-tls/fixtures'
import {
  ETCD_IMAGE,
  eventually,
  getAvailablePort,
  makeAllocationTable,
  makeNodeRegistration,
  runDocker,
  stopEtcdContainer,
} from './fixtures'

const ROOT_PASSWORD = 'quince-ledger-7'
const CERTIFICATE_DIRECTORY = '/certs'

async function codeOf(work: Promise<ClusterCoordinator>): Promise<string> {
  let coordinator: ClusterCoordinator
  try {
    coordinator = await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  await coordinator.shutdown()
  throw new Error('expected the coordinator to refuse')
}

describe('an etcd that requires TLS, a client certificate, and a password', () => {
  let bundles: TlsBundles
  let certificates = ''
  let containerName: string | null = null
  let endpoint = ''

  function etcdctl(...args: string[]): Promise<string> {
    if (containerName === null) throw new Error('the etcd container is not running')
    return runDocker([
      'exec',
      containerName,
      '/usr/local/bin/etcdctl',
      '--endpoints=https://127.0.0.1:2379',
      `--cacert=${CERTIFICATE_DIRECTORY}/ca.crt`,
      `--cert=${CERTIFICATE_DIRECTORY}/client.crt`,
      `--key=${CERTIFICATE_DIRECTORY}/client.key`,
      ...args,
    ])
  }

  function settings(overrides: Partial<EtcdCoordinatorConfig> = {}): Partial<EtcdCoordinatorConfig> {
    return {
      endpoints: [endpoint],
      keyPrefix: `_narsil_secured_${randomUUID()}`,
      tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
      auth: { username: 'root', password: ROOT_PASSWORD },
      ...overrides,
    }
  }

  beforeAll(async () => {
    await runDocker(['version'])
    bundles = await generateTlsBundles()
    certificates = await mkdtemp(join(tmpdir(), 'narsil-etcd-tls-'))
    await chmod(certificates, 0o755)
    const files: Array<[string, string]> = [
      ['ca.crt', bundles.serverBundle.ca],
      ['server.crt', bundles.serverBundle.cert],
      ['server.key', bundles.serverBundle.key],
      ['client.crt', bundles.clientBundle.cert],
      ['client.key', bundles.clientBundle.key],
    ]
    for (const [name, contents] of files) {
      await writeFile(join(certificates, name), contents, { mode: 0o644 })
    }

    const hostPort = await getAvailablePort()
    endpoint = `https://127.0.0.1:${hostPort}`
    containerName = `narsil-etcd-${randomUUID()}`
    await runDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '-p',
      `127.0.0.1:${hostPort}:2379`,
      '-v',
      `${certificates}:${CERTIFICATE_DIRECTORY}:ro`,
      ETCD_IMAGE,
      '/usr/local/bin/etcd',
      '--name',
      'node1',
      '--data-dir',
      '/etcd-data',
      '--listen-client-urls',
      'https://0.0.0.0:2379',
      '--advertise-client-urls',
      endpoint,
      '--cert-file',
      `${CERTIFICATE_DIRECTORY}/server.crt`,
      '--key-file',
      `${CERTIFICATE_DIRECTORY}/server.key`,
      '--trusted-ca-file',
      `${CERTIFICATE_DIRECTORY}/ca.crt`,
      '--client-cert-auth',
      '--listen-peer-urls',
      'http://0.0.0.0:2380',
      '--initial-advertise-peer-urls',
      'http://127.0.0.1:2380',
      '--initial-cluster',
      'node1=http://127.0.0.1:2380',
    ])
    await eventually(
      async () => {
        await etcdctl('endpoint', 'health')
      },
      30_000,
      'the secured etcd never became healthy',
    )
    await etcdctl('user', 'add', 'root', `--new-user-password=${ROOT_PASSWORD}`)
    await etcdctl('user', 'grant-role', 'root', 'root').catch(() => '')
    await etcdctl('auth', 'enable')
  }, 90_000)

  afterAll(async () => {
    await stopEtcdContainer(containerName)
    containerName = null
    if (certificates !== '') await rm(certificates, { recursive: true, force: true })
  }, 30_000)

  it('stores and reads back what a coordinator with the right certificates and password writes', async () => {
    const coordinator = await createEtcdCoordinator(settings())
    try {
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'orchard-node' }))
      expect((await coordinator.listNodes()).map(node => node.nodeId)).toEqual(['orchard-node'])
      expect(await coordinator.acquireLease('_narsil/controller', 'orchard-node', 30_000)).toBe(true)
      expect(await coordinator.putAllocation('orchards', makeAllocationTable('orchards'), null, 'orchard-node')).toBe(
        true,
      )
      expect((await coordinator.getAllocation('orchards'))?.assignments.get(0)?.primary).toBe('node-1')
    } finally {
      await coordinator.shutdown()
    }
  }, 30_000)

  it('refuses a wrong password with COORDINATOR_AUTH_FAILED', async () => {
    expect(await codeOf(createEtcdCoordinator(settings({ auth: { username: 'root', password: 'wrong' } })))).toBe(
      ErrorCodes.COORDINATOR_AUTH_FAILED,
    )
  }, 30_000)

  it('refuses an etcd whose certificate chains to another authority with COORDINATOR_UNAVAILABLE', async () => {
    const tls = { ca: bundles.rogueBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key }
    expect(await codeOf(createEtcdCoordinator(settings({ tls })))).toBe(ErrorCodes.COORDINATOR_UNAVAILABLE)
  }, 30_000)
})
