import { act, createElement, type ReactNode, StrictMode, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createNarsilClient, type FetchFunction, type NarsilClient } from '../../client'
import { NarsilProvider } from '../../react'

export interface Exchange {
  url: string
  method: string
  body: string | undefined
  signal: AbortSignal | null
}

export interface Route {
  match: (url: string, method: string) => boolean
  answer: (url: string, method: string) => Promise<{ status: number; body: unknown }>
}

export interface StubServer {
  fetch: FetchFunction
  calls: Exchange[]
  urls: () => string[]
  countOf: (fragment: string) => number
}

export function json(body: unknown, status = 200): Promise<{ status: number; body: unknown }> {
  return Promise.resolve({ status, body })
}

export function stubServer(routes: Route[]): StubServer {
  const calls: Exchange[] = []
  const fetch: FetchFunction = async (url, init) => {
    const method = init.method ?? 'GET'
    calls.push({
      url,
      method,
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? null,
    })
    const route = routes.find(candidate => candidate.match(url, method))
    const answered = route === undefined ? { status: 404, body: notFound(url) } : await route.answer(url, method)
    if (init.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
    return {
      ok: answered.status >= 200 && answered.status < 300,
      status: answered.status,
      text: () => Promise.resolve(JSON.stringify(answered.body)),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response
  }
  return {
    fetch,
    calls,
    urls: () => calls.map(call => call.url),
    countOf: fragment => calls.filter(call => call.url.includes(fragment)).length,
  }
}

function notFound(url: string): unknown {
  return { error: { code: 'NOT_FOUND', message: `No stub route answers ${url}` } }
}

export function route(fragment: string, answer: Route['answer'], method = 'GET'): Route {
  return { match: (url, sent) => sent === method && url.includes(fragment), answer }
}

export function clientFor(server: StubServer): NarsilClient {
  return createNarsilClient({ url: 'http://narsil.test', fetch: server.fetch })
}

export interface Rendered<T> {
  at: (index: number) => T
  current: () => T
  renders: () => number
  rerender: () => Promise<void>
  unmount: () => Promise<void>
}

function actEnvironment(): void {
  const scope = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  scope.IS_REACT_ACT_ENVIRONMENT = true
}

export async function renderHook<T>(
  useHook: () => T,
  client: NarsilClient,
  options?: { strict?: boolean },
): Promise<Rendered<T>> {
  actEnvironment()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const seen: T[] = []
  let again: (() => void) | null = null

  function Probe(): null {
    seen.push(useHook())
    return null
  }

  function Harness(): ReactNode {
    const [, setTick] = useState(0)
    useEffect(() => {
      again = () => setTick(tick => tick + 1)
    })
    return createElement(Probe)
  }

  let root: Root | null = null
  await act(async () => {
    root = createRoot(container)
    const tree = createElement(NarsilProvider, { client }, createElement(Harness))
    root.render(options?.strict === true ? createElement(StrictMode, null, tree) : tree)
  })

  return {
    at: index => seen[index],
    current: () => seen[seen.length - 1],
    renders: () => seen.length,
    rerender: async () => {
      await act(async () => {
        again?.()
      })
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

export async function renderBare(element: ReactNode): Promise<void> {
  actEnvironment()
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(element)
  })
}

export async function interact(work: () => void): Promise<void> {
  await act(async () => {
    work()
  })
}

export function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export async function settle(milliseconds = 5): Promise<void> {
  await act(async () => {
    await sleep(milliseconds)
  })
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('The condition never held')
    await settle(5)
  }
}
