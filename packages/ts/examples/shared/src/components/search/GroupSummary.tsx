import type { GroupResult } from '@delali/narsil'

interface GroupSummaryProps {
  groups: GroupResult[]
  totalField: string | null
}

function describeValues(values: Record<string, unknown>): string {
  return Object.values(values)
    .map(value => (value === null || value === undefined ? 'no value' : String(value)))
    .join(', ')
}

function formatTotal(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString() : String(value)
}

export function GroupSummary({ groups, totalField }: GroupSummaryProps) {
  if (groups.length === 0) return null

  return (
    <div className="mb-4 rounded-lg border" data-testid="group-summary">
      <div className="border-b px-4 py-2 text-xs font-semibold">
        {groups.length} group{groups.length === 1 ? '' : 's'}
        {totalField === null ? null : (
          <span className="font-normal text-muted-foreground"> with the total of {totalField}</span>
        )}
      </div>
      <table className="w-full text-xs">
        <tbody>
          {groups.map(group => {
            const label = describeValues(group.values)
            return (
              <tr key={label} className="border-b last:border-b-0" data-testid="group-row">
                <td className="px-4 py-1.5 font-medium" data-testid="group-value">
                  {label}
                </td>
                <td className="px-4 py-1.5 text-muted-foreground">{group.hits.map(hit => hit.id).join(', ')}</td>
                {totalField === null ? null : (
                  <td className="px-4 py-1.5 text-right font-mono" data-testid="group-total">
                    {group.reducerError === undefined ? formatTotal(group.reduced) : group.reducerError}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
