import type { Etcd3 as Etcd3Client } from 'etcd3'
import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { ETCD_START_PROBE_TIMEOUT_MS } from './constants'

type Etcd3Module = typeof import('etcd3')

function refusedCredentials(etcd3: Etcd3Module, error: unknown): boolean {
  return (
    error instanceof etcd3.EtcdAuthenticationFailedError ||
    error instanceof etcd3.EtcdInvalidAuthTokenError ||
    error instanceof etcd3.EtcdPermissionDeniedError ||
    error instanceof etcd3.EtcdUserNotFoundError
  )
}

function probeFailure(etcd3: Etcd3Module, error: unknown, endpoints: string[]): NarsilError {
  if (error instanceof NarsilError) {
    return error
  }
  if (refusedCredentials(etcd3, error)) {
    return new NarsilError(ErrorCodes.COORDINATOR_AUTH_FAILED, 'etcd refused the coordinator credentials', {
      endpoints,
      cause: describeError(error),
    })
  }
  return new NarsilError(
    ErrorCodes.COORDINATOR_UNAVAILABLE,
    'The coordinator could not reach any etcd endpoint or complete a TLS handshake with one',
    { endpoints, cause: describeError(error) },
  )
}

export async function probeEtcd(
  client: Etcd3Client,
  etcd3: Etcd3Module,
  probeKey: string,
  endpoints: string[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new NarsilError(
          ErrorCodes.COORDINATOR_UNAVAILABLE,
          `No etcd endpoint answered within ${ETCD_START_PROBE_TIMEOUT_MS} ms`,
          { endpoints, timeoutMs: ETCD_START_PROBE_TIMEOUT_MS },
        ),
      )
    }, ETCD_START_PROBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([client.get(probeKey).exec(), timedOut])
  } catch (error) {
    throw probeFailure(etcd3, error, endpoints)
  } finally {
    clearTimeout(timer)
  }
}
