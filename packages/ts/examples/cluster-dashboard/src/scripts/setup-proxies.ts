import { NODES } from '../topology'

interface ProxySpec {
  name: string
  listen: string
  upstream: string
}

const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? 'http://toxiproxy:8474'
const READY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000
const READY_POLL_INTERVAL_MS = 500
const ETCD_UPSTREAM = 'etcd:2379'

const proxies: ProxySpec[] = NODES.flatMap(spec => [
  {
    name: spec.etcdProxyName,
    listen: `0.0.0.0:${spec.etcdProxyPort}`,
    upstream: ETCD_UPSTREAM,
  },
  {
    name: spec.replicationProxyName,
    listen: `0.0.0.0:${spec.replicationPort}`,
    upstream: `${spec.nodeId}:${spec.replicationPort}`,
  },
])

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function waitForToxiproxy(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${TOXIPROXY_URL}/proxies`)
      if (response.ok) return
    } catch (_) {}
    await delay(READY_POLL_INTERVAL_MS)
  }
  throw new Error(`Toxiproxy never became ready at ${TOXIPROXY_URL}`)
}

async function deleteProxy(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${TOXIPROXY_URL}/proxies/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    throw new Error(`Toxiproxy refused to delete '${name}': HTTP ${response.status}`)
  }
}

async function createProxy(proxy: ProxySpec): Promise<void> {
  const response = await fetchWithTimeout(`${TOXIPROXY_URL}/proxies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...proxy, enabled: true }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Toxiproxy refused to create '${proxy.name}': HTTP ${response.status} ${body}`)
  }
}

await waitForToxiproxy()

for (const proxy of proxies) {
  await deleteProxy(proxy.name)
  await createProxy(proxy)
}

console.log(`Created ${proxies.length} Toxiproxy links`)
