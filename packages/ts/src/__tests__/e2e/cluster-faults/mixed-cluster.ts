import { setTimeout as sleep } from 'node:timers/promises'
import { Etcd3 } from 'etcd3'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/cluster/controller'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import type { TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers } from './etcd-members'
import { send } from './workload'

const POLL_MS = 200
const REQUEST_TIMEOUT_MS = 20_000
const CREATE_TIMEOUT_MS = 60_000

export async function connectCoordinator(
  etcd: EtcdMembers,
  bundles: TlsBundles | null,
  keyPrefix: string,
): Promise<ClusterCoordinator> {
  const security =
    bundles === null
      ? {}
      : {
          tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
          auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
        }
  return createEtcdCoordinator({ endpoints: [...etcd.endpoints], keyPrefix, ...security })
}

export function connectRawEtcd(etcd: EtcdMembers, bundles: TlsBundles | null): Etcd3 {
  return new Etcd3({
    hosts: [...etcd.endpoints],
    ...(bundles === null
      ? {}
      : {
          credentials: {
            rootCertificate: Buffer.from(bundles.serverBundle.ca),
            certChain: Buffer.from(bundles.clientBundle.cert),
            privateKey: Buffer.from(bundles.clientBundle.key),
          },
          auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
        }),
  })
}

export async function waitFor<T>(
  description: string,
  timeoutMs: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()
  while (!done(latest)) {
    if (Date.now() > deadline) {
      throw new Error(`${description} within ${timeoutMs} ms; the last reading was ${JSON.stringify(latest)}`)
    }
    await sleep(POLL_MS)
    latest = await read()
  }
  return latest
}

export function leaseHolder(coordinator: ClusterCoordinator): Promise<string | null> {
  return coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
}

export async function createIndex(base: string, indexName: string): Promise<void> {
  const created = await send(
    base,
    'POST',
    '/indexes',
    { name: indexName, config: { schema: { title: 'string' } } },
    CREATE_TIMEOUT_MS,
  )
  if (created.status !== 201) throw new Error(`Index '${indexName}' was not created: ${created.text}`)
}

export async function insertEntries(base: string, indexName: string, count: number): Promise<void> {
  for (let at = 0; at < count; at++) {
    const inserted = await send(
      base,
      'POST',
      `/indexes/${indexName}/documents`,
      { id: `entry-${at}`, document: { title: `ledger entry ${at}` } },
      REQUEST_TIMEOUT_MS,
    )
    if (inserted.status >= 300) throw new Error(`Entry ${at} of '${indexName}' was refused: ${inserted.text}`)
  }
}

export async function searchCount(base: string, indexName: string): Promise<number> {
  const found = await send(
    base,
    'POST',
    `/indexes/${indexName}/search`,
    { term: 'ledger', limit: 100 },
    REQUEST_TIMEOUT_MS,
  )
  if (found.status !== 200) return -1
  return Number((JSON.parse(found.text) as { count?: unknown }).count)
}
