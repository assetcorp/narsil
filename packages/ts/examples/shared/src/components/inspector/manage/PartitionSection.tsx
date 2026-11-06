import { type ChangeEvent, useCallback, useState } from 'react'
import { useEngineActions } from '../../../engine-actions'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

const MAX_DEMO_PARTITIONS = 64
const MAX_DEMO_DOCS_PER_PARTITION = 10_000_000

function wholeNumber(raw: string, low: number, high: number, label: string): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) {
    throw new Error(`${label} has to be a whole number from ${low} to ${high.toLocaleString()}.`)
  }
  return parsed
}

export function PartitionSection({ indexName, partitionCount }: { indexName: string; partitionCount: number }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const [target, setTarget] = useState(String(partitionCount))
  const [maxDocs, setMaxDocs] = useState('')
  const { run } = runner

  const handleTargetChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTarget(event.target.value)
  }, [])

  const handleMaxDocsChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setMaxDocs(event.target.value)
  }, [])

  const handleRebalance = useCallback(() => {
    void run('Spreading the documents across partitions', async () => {
      const count = wholeNumber(target, 1, MAX_DEMO_PARTITIONS, 'The partition count')
      await actions.rebalance(indexName, count)
      actions.onChanged(indexName)
      return `The index holds its documents in ${count} partition${count === 1 ? '' : 's'}.`
    })
  }, [actions, indexName, run, target])

  const handleUpdateConfig = useCallback(() => {
    void run('Saving the partition settings', async () => {
      const limit = wholeNumber(maxDocs, 1, MAX_DEMO_DOCS_PER_PARTITION, 'The partition size')
      await actions.updatePartitionConfig(indexName, { maxDocsPerPartition: limit })
      actions.onChanged(indexName)
      return `A partition splits once it holds ${limit.toLocaleString()} documents.`
    })
  }, [actions, indexName, maxDocs, run])

  return (
    <ManageSection
      title="Partitions"
      description="Rebalance the index across another number of partitions, or change the size at which a partition splits."
      state={runner.state}
      testId="manage-partitions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          min="1"
          max={MAX_DEMO_PARTITIONS}
          value={target}
          onChange={handleTargetChange}
          aria-label="Partition count"
          className="h-8 w-24 text-xs"
        />
        <Button type="button" size="sm" variant="outline" onClick={handleRebalance} disabled={runner.isRunning}>
          Rebalance
        </Button>
        <Input
          type="number"
          min="1"
          value={maxDocs}
          onChange={handleMaxDocsChange}
          placeholder="Documents per partition"
          aria-label="Documents per partition"
          className="h-8 w-48 text-xs"
        />
        <Button type="button" size="sm" variant="outline" onClick={handleUpdateConfig} disabled={runner.isRunning}>
          Save split size
        </Button>
      </div>
    </ManageSection>
  )
}
