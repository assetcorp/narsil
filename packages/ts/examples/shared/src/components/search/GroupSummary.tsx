import type { GroupResult, Hit } from '@delali/narsil'
import { useCallback, useState } from 'react'
import { type DisplayFieldMapping, displayHeading } from '../../lib/display-fields'
import { Button } from '../ui/button'
import { HitDetailSheet } from './HitDetailSheet'

const GROUPS_SHOWN_COLLAPSED = 10

interface GroupSummaryProps {
  groups: GroupResult[]
  totalField: string | null
  displayFields: DisplayFieldMapping | null
}

function describeValues(values: Record<string, unknown>): string {
  return Object.values(values)
    .map(value => (value === null || value === undefined ? 'no value' : String(value)))
    .join(', ')
}

function formatTotal(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString() : String(value)
}

function GroupHitButton({
  hit,
  displayFields,
  onSelect,
}: {
  hit: Hit
  displayFields: DisplayFieldMapping | null
  onSelect: (hit: Hit) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(hit)
  }, [onSelect, hit])

  return (
    <button
      type="button"
      data-testid="group-hit"
      data-doc-id={hit.id}
      onClick={handleClick}
      className="cursor-pointer text-left underline-offset-2 hover:text-foreground hover:underline"
    >
      {displayHeading(hit.document, displayFields, hit.id)}
    </button>
  )
}

function GroupRow({
  group,
  totalField,
  displayFields,
  onSelect,
}: {
  group: GroupResult
  totalField: string | null
  displayFields: DisplayFieldMapping | null
  onSelect: (hit: Hit) => void
}) {
  return (
    <tr className="border-b last:border-b-0" data-testid="group-row">
      <td className="px-4 py-1.5 align-top font-medium" data-testid="group-value">
        {describeValues(group.values)}
      </td>
      <td className="px-4 py-1.5 text-muted-foreground">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {group.hits.map(hit => (
            <GroupHitButton key={hit.id} hit={hit} displayFields={displayFields} onSelect={onSelect} />
          ))}
        </div>
      </td>
      {totalField === null ? null : (
        <td className="px-4 py-1.5 text-right align-top font-mono" data-testid="group-total">
          {group.reducerError === undefined ? formatTotal(group.reduced) : group.reducerError}
        </td>
      )}
    </tr>
  )
}

export function GroupSummary({ groups, totalField, displayFields }: GroupSummaryProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedHit, setSelectedHit] = useState<Hit | null>(null)

  const handleToggle = useCallback(() => {
    setExpanded(current => !current)
  }, [])

  const handleDetailClose = useCallback(() => {
    setSelectedHit(null)
  }, [])

  if (groups.length === 0) return null

  const collapsible = groups.length > GROUPS_SHOWN_COLLAPSED
  const shown = expanded || !collapsible ? groups : groups.slice(0, GROUPS_SHOWN_COLLAPSED)

  return (
    <div className="mb-4 rounded-lg border" data-testid="group-summary">
      <div className="border-b px-4 py-2 text-xs font-semibold">
        {groups.length} group{groups.length === 1 ? '' : 's'}
        {totalField === null ? null : (
          <span className="font-normal text-muted-foreground"> with the total of {totalField}</span>
        )}
      </div>
      <div className={expanded ? 'max-h-96 overflow-y-auto' : undefined}>
        <table className="w-full text-xs">
          <tbody>
            {shown.map(group => (
              <GroupRow
                key={describeValues(group.values)}
                group={group}
                totalField={totalField}
                displayFields={displayFields}
                onSelect={setSelectedHit}
              />
            ))}
          </tbody>
        </table>
      </div>
      {collapsible ? (
        <div className="border-t px-4 py-2">
          <Button type="button" variant="outline" size="xs" aria-expanded={expanded} onClick={handleToggle}>
            {expanded ? `Show the first ${GROUPS_SHOWN_COLLAPSED} groups` : `Show all ${groups.length} groups`}
          </Button>
        </div>
      ) : null}
      <HitDetailSheet hit={selectedHit} displayFields={displayFields} onClose={handleDetailClose} />
    </div>
  )
}
