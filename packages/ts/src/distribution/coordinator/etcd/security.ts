import type { IOptions } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { EtcdCoordinatorConfig } from './types'

const SECURE_SCHEME = 'https://'
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const LOOPBACK_NAMES = new Set(['localhost', '[::1]', '::1'])

function hostnameOf(endpoint: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch (_) {
    return null
  }
}

function isLoopback(endpoint: string): boolean {
  const hostname = hostnameOf(endpoint)
  return hostname !== null && (LOOPBACK_NAMES.has(hostname) || LOOPBACK_IPV4.test(hostname))
}

function refuse(message: string, details: Record<string, unknown> = {}): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, message, details)
}

function validateTls(config: EtcdCoordinatorConfig): void {
  const tls = config.tls
  if (tls === undefined) {
    return
  }
  if ((tls.cert === undefined) !== (tls.key === undefined)) {
    refuse('etcd tls needs both cert and key to present a client certificate, or neither')
  }
  const plain = config.endpoints.filter(endpoint => !endpoint.startsWith(SECURE_SCHEME))
  if (plain.length > 0) {
    refuse('Every etcd endpoint must start with https:// when tls is set', { endpoints: plain })
  }
}

function validateAuth(config: EtcdCoordinatorConfig): void {
  const auth = config.auth
  if (auth === undefined) {
    return
  }
  if (
    typeof auth.username !== 'string' ||
    typeof auth.password !== 'string' ||
    auth.username.length === 0 ||
    auth.password.length === 0
  ) {
    refuse('etcd auth needs a username and a password that are not empty')
  }
  const exposed = config.endpoints.filter(endpoint => !endpoint.startsWith(SECURE_SCHEME) && !isLoopback(endpoint))
  if (exposed.length > 0) {
    refuse('etcd auth sends its password over https://, or over http:// to a loopback address alone', {
      endpoints: exposed,
    })
  }
}

export function etcdSecurityOptions(config: EtcdCoordinatorConfig): Pick<IOptions, 'credentials' | 'auth'> {
  validateTls(config)
  validateAuth(config)
  const options: Pick<IOptions, 'credentials' | 'auth'> = {}
  if (config.tls !== undefined) {
    options.credentials = {
      rootCertificate: Buffer.from(config.tls.ca),
      ...(config.tls.key === undefined ? {} : { privateKey: Buffer.from(config.tls.key) }),
      ...(config.tls.cert === undefined ? {} : { certChain: Buffer.from(config.tls.cert) }),
    }
  }
  if (config.auth !== undefined) {
    options.auth = { username: config.auth.username, password: config.auth.password }
  }
  return options
}
