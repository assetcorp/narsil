import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ETCD_IMAGE,
  eventually,
  getAvailablePort,
  runDocker,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import type { TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'

const MEMBER_COUNT = 3
const CERTIFICATE_DIRECTORY = '/certs'
const HEALTHY_TIMEOUT_MS = 60_000
export const ETCD_ROOT_PASSWORD = 'harbour-ledger-31'

export interface EtcdMembers {
  readonly endpoints: readonly string[]
  readonly hostPorts: readonly number[]
  readonly secure: boolean
  restart(member: number): Promise<void>
  stop(member: number): Promise<void>
  start(member: number): Promise<void>
  remove(): Promise<void>
}

function memberName(run: string, member: number): string {
  return `narsil-fault-etcd-${run}-${member}`
}

export async function startEtcdMembers(bundles: TlsBundles | null): Promise<EtcdMembers> {
  const run = randomUUID().slice(0, 8)
  const network = `narsil-fault-net-${run}`
  const secure = bundles !== null
  const scheme = secure ? 'https' : 'http'
  const hostPorts: number[] = []
  for (let member = 0; member < MEMBER_COUNT; member++) hostPorts.push(await getAvailablePort())
  const names = hostPorts.map((_, member) => memberName(run, member))
  const certificates = secure ? await mkdtemp(join(tmpdir(), 'narsil-fault-etcd-')) : null

  async function remove(): Promise<void> {
    for (const name of names) await runDocker(['rm', '--force', name]).catch(() => '')
    await runDocker(['network', 'rm', network]).catch(() => '')
    if (certificates !== null) await rm(certificates, { recursive: true, force: true })
  }

  function etcdctl(member: number, ...args: string[]): Promise<string> {
    const tlsFlags = secure
      ? [
          `--cacert=${CERTIFICATE_DIRECTORY}/ca.crt`,
          `--cert=${CERTIFICATE_DIRECTORY}/client.crt`,
          `--key=${CERTIFICATE_DIRECTORY}/client.key`,
        ]
      : []
    return runDocker([
      'exec',
      names[member] ?? '',
      '/usr/local/bin/etcdctl',
      `--endpoints=${scheme}://127.0.0.1:2379`,
      ...tlsFlags,
      ...args,
    ])
  }

  try {
    if (certificates !== null && bundles !== null) {
      await chmod(certificates, 0o755)
      const files: Array<[string, string]> = [
        ['ca.crt', bundles.serverBundle.ca],
        ['server.crt', bundles.serverBundle.cert],
        ['server.key', bundles.serverBundle.key],
        ['client.crt', bundles.clientBundle.cert],
        ['client.key', bundles.clientBundle.key],
      ]
      for (const [name, contents] of files) await writeFile(join(certificates, name), contents, { mode: 0o644 })
    }
    await runDocker(['network', 'create', network])
    const initialCluster = names.map((name, member) => `m${member}=http://${name}:2380`).join(',')
    for (let member = 0; member < MEMBER_COUNT; member++) {
      const name = names[member] ?? ''
      const tlsFlags = secure
        ? [
            '--cert-file',
            `${CERTIFICATE_DIRECTORY}/server.crt`,
            '--key-file',
            `${CERTIFICATE_DIRECTORY}/server.key`,
            '--trusted-ca-file',
            `${CERTIFICATE_DIRECTORY}/ca.crt`,
            '--client-cert-auth',
          ]
        : []
      await runDocker([
        'run',
        '--detach',
        '--name',
        name,
        '--network',
        network,
        '-p',
        `127.0.0.1:${hostPorts[member]}:2379`,
        ...(certificates === null ? [] : ['-v', `${certificates}:${CERTIFICATE_DIRECTORY}:ro`]),
        ETCD_IMAGE,
        '/usr/local/bin/etcd',
        '--name',
        `m${member}`,
        '--data-dir',
        '/etcd-data',
        '--listen-client-urls',
        `${scheme}://0.0.0.0:2379`,
        '--advertise-client-urls',
        `${scheme}://127.0.0.1:${hostPorts[member]}`,
        '--listen-peer-urls',
        'http://0.0.0.0:2380',
        '--initial-advertise-peer-urls',
        `http://${name}:2380`,
        '--initial-cluster',
        initialCluster,
        '--initial-cluster-state',
        'new',
        ...tlsFlags,
      ])
    }
    for (let member = 0; member < MEMBER_COUNT; member++) {
      await eventually(
        async () => {
          await etcdctl(member, 'endpoint', 'health')
        },
        HEALTHY_TIMEOUT_MS,
        `etcd member ${member} never became healthy`,
      )
    }
    if (secure) {
      await etcdctl(0, 'user', 'add', 'root', `--new-user-password=${ETCD_ROOT_PASSWORD}`)
      await etcdctl(0, 'user', 'grant-role', 'root', 'root').catch(() => '')
      await etcdctl(0, 'auth', 'enable')
    }
  } catch (error) {
    await remove()
    throw error
  }

  async function awaitHealthy(member: number): Promise<void> {
    const credentials = secure ? ['--user', `root:${ETCD_ROOT_PASSWORD}`] : []
    await eventually(
      async () => {
        await etcdctl(member, ...credentials, 'endpoint', 'health')
      },
      HEALTHY_TIMEOUT_MS,
      `etcd member ${member} never came back`,
    )
  }

  return {
    endpoints: hostPorts.map(port => `${scheme}://127.0.0.1:${port}`),
    hostPorts,
    secure,
    async restart(member) {
      await runDocker(['restart', '--time', '0', names[member] ?? ''])
      await awaitHealthy(member)
    },
    async stop(member) {
      await runDocker(['stop', '--time', '0', names[member] ?? ''])
    },
    async start(member) {
      await runDocker(['start', names[member] ?? ''])
    },
    remove,
  }
}
