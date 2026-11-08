import { useCallback } from 'react'
import { useEngineActions } from '../../../engine-actions'
import { Button } from '../../ui/button'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

export function VectorSection({ indexName }: { indexName: string }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const { run } = runner

  const handleCompact = useCallback(() => {
    void run('Compacting the vectors', async () => {
      await actions.compactVectors(indexName)
      actions.onChanged(indexName)
      return 'The vector fields hold no space for removed vectors.'
    })
  }, [actions, indexName, run])

  const handleOptimize = useCallback(() => {
    void run('Rebuilding the vector graphs', async () => {
      await actions.optimizeVectors(indexName)
      actions.onChanged(indexName)
      return 'The vector graphs are rebuilt.'
    })
  }, [actions, indexName, run])

  return (
    <ManageSection
      title="Vector maintenance"
      description="Compacting reclaims the space that removed vectors hold. Optimising rebuilds each graph, so a search reaches full speed again."
      state={runner.state}
      testId="manage-vectors"
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={handleCompact} disabled={runner.isRunning}>
          Compact vectors
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleOptimize} disabled={runner.isRunning}>
          Optimise vectors
        </Button>
      </div>
    </ManageSection>
  )
}
