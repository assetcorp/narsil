import { ServerErrorCodes, type TaskStore } from '@delali/narsil/server'

export async function reconcileLocalTasks(store: TaskStore): Promise<void> {
  for (const record of await store.list()) {
    if (record.status !== 'running') continue
    await store.set({
      ...record,
      status: 'failed',
      completedAt: Date.now(),
      error: { code: ServerErrorCodes.TASK_INTERRUPTED, message: 'The server restarted while this task was running' },
    })
  }
}
