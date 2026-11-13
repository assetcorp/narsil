import type { WorkerAction } from './protocol'

export interface Executor {
  execute<T>(action: WorkerAction, transfer?: object[]): Promise<T>
  executeUntilAnswered?<T>(action: WorkerAction, settled?: () => void): Promise<T>
  shutdown(): Promise<void>
}

export function executeUntilAnswered<T>(executor: Executor, action: WorkerAction, settled?: () => void): Promise<T> {
  try {
    if (executor.executeUntilAnswered !== undefined) return executor.executeUntilAnswered<T>(action, settled)
    const answered = executor.execute<T>(action)
    return settled === undefined ? answered : answered.finally(settled)
  } catch (error) {
    settled?.()
    return Promise.reject(error)
  }
}
