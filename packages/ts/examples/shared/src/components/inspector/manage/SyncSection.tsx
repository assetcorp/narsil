import { useCallback } from 'react'
import { type EngineSyncActions, useEngineActions } from '../../../engine-actions'
import { Button } from '../../ui/button'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

export function SyncSection({ indexName, sync }: { indexName: string; sync: EngineSyncActions }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const { run } = runner

  const switchSync = useCallback(
    (enabled: boolean) => {
      void run(enabled ? 'Turning device sync on' : 'Turning device sync off', async () => {
        await sync.updateSync(indexName, enabled)
        actions.onChanged(indexName)
        return enabled
          ? `Sync is on for ${indexName}. Devices can download it and follow its changes.`
          : `Sync is off for ${indexName}. The server closed every feed of it and deleted its history.`
      })
    },
    [actions, indexName, run, sync],
  )

  const handleTurnOn = useCallback(() => switchSync(true), [switchSync])
  const handleTurnOff = useCallback(() => switchSync(false), [switchSync])

  return (
    <ManageSection
      title="Device sync"
      description="With sync on, a device keeps a copy of this index, searches it offline, and sends its edits back. Every device receives the whole index."
      state={runner.state}
      testId="manage-sync"
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={handleTurnOn} disabled={runner.isRunning}>
          Turn sync on
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleTurnOff} disabled={runner.isRunning}>
          Turn sync off
        </Button>
      </div>
    </ManageSection>
  )
}
