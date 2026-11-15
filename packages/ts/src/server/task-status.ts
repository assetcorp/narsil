import type { TaskStatus, TaskType } from './types/tasks'

const TASK_TYPE_SET: Readonly<Record<TaskType, true>> = {
  optimizeVectors: true,
  rebalance: true,
  restore: true,
  import: true,
  importExport: true,
  rebuildAnalysis: true,
  changeAnalysis: true,
  backup: true,
  backupRestore: true,
  backupDelete: true,
  querySuggestionsBuild: true,
}

export const TASK_TYPES = Object.keys(TASK_TYPE_SET) as TaskType[]
export const TASK_STATUSES: readonly TaskStatus[] = ['running', 'succeeded', 'failed', 'cancelled']

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled'])

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && Object.hasOwn(TASK_TYPE_SET, value)
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}
