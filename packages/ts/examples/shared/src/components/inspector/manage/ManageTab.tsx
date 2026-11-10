import { useEngineActions } from '../../../engine-actions'
import { AnalysisSection } from './AnalysisSection'
import { BackupSection } from './BackupSection'
import { PartitionSection } from './PartitionSection'
import { SyncSection } from './SyncSection'
import { SynonymsSection } from './SynonymsSection'
import { VectorSection } from './VectorSection'

interface ManageTabProps {
  indexName: string
  language: string
  partitionCount: number
  hasVectors: boolean
}

export function ManageTab({ indexName, language, partitionCount, hasVectors }: ManageTabProps) {
  const actions = useEngineActions()

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SynonymsSection key={`synonyms-${indexName}`} indexName={indexName} />
      <AnalysisSection key={`analysis-${indexName}-${language}`} indexName={indexName} language={language} />
      <PartitionSection
        key={`partitions-${indexName}-${partitionCount}`}
        indexName={indexName}
        partitionCount={partitionCount}
      />
      {hasVectors ? <VectorSection indexName={indexName} /> : null}
      <BackupSection indexName={indexName} />
      {actions.sync === null ? null : (
        <SyncSection key={`sync-${indexName}`} indexName={indexName} sync={actions.sync} />
      )}
    </div>
  )
}
