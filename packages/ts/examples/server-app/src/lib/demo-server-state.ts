import type { EngineStatus } from './engine-status'

export interface DemoNarsilServer {
  url: string
  close(): Promise<void>
}

/* The Vite config loads demo-server.ts as a plain Node module while the app's
 * server code runs in a separate SSR module graph, so state they share must
 * live on globalThis under Symbol.for keys rather than in module scope. */
const SERVER_KEY = Symbol.for('narsil-server-app-demo-server')
const STATUS_KEY = Symbol.for('narsil-server-app-demo-server-status')

const g = globalThis as unknown as Record<symbol, unknown>

export function demoServerPromise(): Promise<DemoNarsilServer> | undefined {
  return g[SERVER_KEY] as Promise<DemoNarsilServer> | undefined
}

export function setDemoServerPromise(promise: Promise<DemoNarsilServer> | undefined): void {
  g[SERVER_KEY] = promise
}

export function demoEngineStatus(): EngineStatus | undefined {
  return g[STATUS_KEY] as EngineStatus | undefined
}

export function setDemoEngineStatus(status: EngineStatus): void {
  g[STATUS_KEY] = status
}
