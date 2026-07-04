export interface NodeWorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  unref?(): void
  terminate(): void | Promise<void>
}

export async function spawnNodeWorker(entryPoint: URL): Promise<NodeWorkerHandle | null> {
  try {
    const workerThreads = await import('node:worker_threads')
    return new workerThreads.Worker(entryPoint) as unknown as NodeWorkerHandle
  } catch {
    return null
  }
}

export async function isNodeMainThread(): Promise<boolean> {
  try {
    const workerThreads = await import('node:worker_threads')
    return workerThreads.isMainThread
  } catch {
    return true
  }
}
