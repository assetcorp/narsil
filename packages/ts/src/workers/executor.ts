import type { WorkerAction } from './protocol'

export interface Executor {
  execute<T>(action: WorkerAction): Promise<T>
  shutdown(): Promise<void>
}
