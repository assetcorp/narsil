import process from 'node:process'

export interface NarsilServerConfig {
  baseUrl: string
  apiKey?: string
}

/**
 * Resolves the Narsil server address and credentials from the environment.
 * Read per request rather than at module load so the value set by the demo
 * server plugin (and any deployment-injected value) is always current, and
 * so no credential can end up in the client bundle.
 */
export function readServerConfig(): NarsilServerConfig {
  const raw = process.env.NARSIL_SERVER_URL
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'NARSIL_SERVER_URL is not set. Run `pnpm dev` to start the bundled demo server, ' +
        'or point NARSIL_SERVER_URL at a running Narsil server.',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`NARSIL_SERVER_URL is not a valid URL: "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`NARSIL_SERVER_URL must use http or https, got "${parsed.protocol}"`)
  }
  const baseUrl = raw.trim().replace(/\/+$/, '')
  const apiKey = process.env.NARSIL_API_KEY
  return apiKey && apiKey.length > 0 ? { baseUrl, apiKey } : { baseUrl }
}
