import { TOXIPROXY_ADMIN_URL } from '../topology'

const REQUEST_TIMEOUT_MS = 3_000

interface ToxiproxyEntry {
  enabled?: unknown
}

function adminUrl(): string {
  return process.env.TOXIPROXY_URL ?? TOXIPROXY_ADMIN_URL
}

async function withRequestTimeout<T>(
  url: string,
  init: RequestInit | undefined,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return await read(response)
  } finally {
    clearTimeout(timer)
  }
}

export async function readProxyStates(): Promise<Map<string, boolean>> {
  const body = await withRequestTimeout(`${adminUrl()}/proxies`, undefined, async response => {
    if (!response.ok) {
      throw new Error(`Toxiproxy answered HTTP ${response.status} when listing proxies`)
    }
    return (await response.json()) as Record<string, ToxiproxyEntry>
  })

  const states = new Map<string, boolean>()
  for (const [name, entry] of Object.entries(body)) {
    if (typeof entry.enabled === 'boolean') {
      states.set(name, entry.enabled)
    }
  }
  return states
}

export async function setProxyEnabled(proxyName: string, enabled: boolean): Promise<void> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }

  await withRequestTimeout(`${adminUrl()}/proxies/${encodeURIComponent(proxyName)}`, init, async response => {
    if (response.ok) {
      return
    }
    const detail = await response.text().catch(() => '')
    throw new Error(`Toxiproxy refused to update '${proxyName}': HTTP ${response.status} ${detail}`)
  })
}
