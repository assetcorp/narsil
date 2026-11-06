import type { SyncStatus } from '@delali/narsil'
import { useCallback, useEffect, useState } from 'react'
import { type EngineSyncActions, useEngineActions } from '../../../engine-actions'
import { Switch } from '../../ui/switch'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

const SYNC_SWITCH_ID = 'manage-sync-enabled'

function describeStatus(status: SyncStatus | null): string {
  if (status === null) return 'Reading the sync setting'
  if (!status.enabled) return 'Sync is off. No device can download this index.'
  return status.active
    ? 'Sync is on, and a device has downloaded this index.'
    : 'Sync is on. No device has downloaded this index yet.'
}

export function SyncSection({ indexName, sync }: { indexName: string; sync: EngineSyncActions }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const { run } = runner

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    sync
      .getSync(indexName)
      .then(current => {
        if (!cancelled) setStatus(current)
      })
      .catch(err => {
        if (!cancelled) void run('Reading the sync setting', () => Promise.reject(err))
      })
    return () => {
      cancelled = true
    }
  }, [indexName, run, sync])

  const handleCheckedChange = useCallback(
    (enabled: boolean) => {
      void run(enabled ? 'Turning device sync on' : 'Turning device sync off', async () => {
        await sync.updateSync(indexName, enabled)
        setStatus(await sync.getSync(indexName))
        actions.onChanged(indexName)
        return enabled
          ? `Sync is on for ${indexName}. Devices can download it and follow its changes.`
          : `Sync is off for ${indexName}. The server closed every feed of it and deleted its history.`
      })
    },
    [actions, indexName, run, sync],
  )

  return (
    <ManageSection
      title="Device sync"
      description="With sync on, a device keeps a copy of this index, searches it offline, and sends its edits back. Every device receives the whole index."
      state={runner.state}
      testId="manage-sync"
    >
      <div className="flex items-center gap-3">
        <Switch
          id={SYNC_SWITCH_ID}
          className="cursor-pointer"
          checked={status?.enabled ?? false}
          onCheckedChange={handleCheckedChange}
          disabled={status === null || runner.isRunning}
        />
        <label htmlFor={SYNC_SWITCH_ID} className="cursor-pointer text-sm">
          Sync this index to devices
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{describeStatus(status)}</p>
    </ManageSection>
  )
}
