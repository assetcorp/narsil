import { type ChangeEvent, useCallback, useRef } from 'react'
import { useEngineActions } from '../../../engine-actions'
import { Button } from '../../ui/button'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

const SNAPSHOT_EXTENSION = '.tar'
const EXPORT_EXTENSION = '.jsonl'

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function takeFile(event: ChangeEvent<HTMLInputElement>): File | null {
  const file = event.target.files?.[0] ?? null
  event.target.value = ''
  return file
}

export function BackupSection({ indexName }: { indexName: string }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const restoreInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const { run } = runner

  const handleSnapshot = useCallback(() => {
    void run('Taking a snapshot', async () => {
      const archive = await actions.snapshot(indexName)
      saveBlob(archive, `${indexName}${SNAPSHOT_EXTENSION}`)
      return `The snapshot holds ${describeBytes(archive.size)}.`
    })
  }, [actions, indexName, run])

  const handleExport = useCallback(() => {
    void run('Exporting the documents', async () => {
      const exported = await actions.exportDocuments(indexName)
      saveBlob(exported, `${indexName}${EXPORT_EXTENSION}`)
      return `The export holds ${describeBytes(exported.size)}.`
    })
  }, [actions, indexName, run])

  const handleChooseRestore = useCallback(() => {
    restoreInput.current?.click()
  }, [])

  const handleChooseImport = useCallback(() => {
    importInput.current?.click()
  }, [])

  const handleRestoreFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = takeFile(event)
      if (file === null) return
      void run(`Restoring ${file.name}`, async () => {
        await actions.restore(indexName, file)
        actions.onChanged(indexName)
        return `The index holds what ${file.name} held.`
      })
    },
    [actions, indexName, run],
  )

  const handleImportFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = takeFile(event)
      if (file === null) return
      void run(`Importing ${file.name}`, async () => {
        await actions.importDocumentExport(indexName, file)
        actions.onChanged(indexName)
        return `The index holds every document in ${file.name}, replacing those with the same ID.`
      })
    },
    [actions, indexName, run],
  )

  return (
    <ManageSection
      title="Snapshots and exports"
      description="A snapshot restores the whole index. An export lists the documents as JSON Lines, and an import adds them back under their IDs."
      state={runner.state}
      testId="manage-backups"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" size="sm" variant="outline" onClick={handleSnapshot} disabled={runner.isRunning}>
          Download snapshot
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleChooseRestore} disabled={runner.isRunning}>
          Restore snapshot
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleExport} disabled={runner.isRunning}>
          Download export
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={handleChooseImport} disabled={runner.isRunning}>
          Import export
        </Button>
      </div>
      <input
        ref={restoreInput}
        type="file"
        accept={SNAPSHOT_EXTENSION}
        aria-label="Snapshot file to restore"
        className="hidden"
        onChange={handleRestoreFile}
      />
      <input
        ref={importInput}
        type="file"
        accept={EXPORT_EXTENSION}
        aria-label="Export file to import"
        className="hidden"
        onChange={handleImportFile}
      />
    </ManageSection>
  )
}
