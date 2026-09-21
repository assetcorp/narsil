import type { TemplatedApp } from 'uWebSockets.js'

export interface AcceptorApp {
  addChildAppDescriptor(descriptor: unknown): unknown
  removeChildAppDescriptor(descriptor: unknown): unknown
}

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
