import type { TemplatedApp } from 'uWebSockets.js'

/**
 * The part of a uWebSockets.js app that moves accepted connections to child
 * apps on other threads, which the pinned binary offers and its typings omit.
 *
 * @internal
 */
export interface AcceptorApp {
  addChildAppDescriptor(descriptor: unknown): unknown
  removeChildAppDescriptor(descriptor: unknown): unknown
}

/**
 * The part of a uWebSockets.js app a request thread hands to the acceptor.
 *
 * @internal
 */
export interface ChildApp {
  getDescriptor(): unknown
  close(): unknown
}

export function acceptorOf(app: TemplatedApp): AcceptorApp | null {
  const candidate = app as unknown as Partial<AcceptorApp>
  if (typeof candidate.addChildAppDescriptor !== 'function') return null
  if (typeof candidate.removeChildAppDescriptor !== 'function') return null
  return candidate as AcceptorApp
}

export function childAppOf(app: TemplatedApp): ChildApp | null {
  const candidate = app as unknown as Partial<ChildApp>
  if (typeof candidate.getDescriptor !== 'function' || typeof candidate.close !== 'function') return null
  return candidate as ChildApp
}
