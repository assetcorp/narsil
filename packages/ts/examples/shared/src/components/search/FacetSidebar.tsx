import type { FacetResult, FilterExpression } from '@delali/narsil'
import { useCallback } from 'react'
import { Badge } from '../ui/badge'

interface FacetSidebarProps {
  facets: Record<string, FacetResult>
  filters: FilterExpression
  onFilterChange: (filters: FilterExpression) => void
}

function FacetValueButton({
  field,
  value,
  count,
  selected,
  onToggle,
}: {
  field: string
  value: string
  count: number
  selected: boolean
  onToggle: (field: string, value: string) => void
}) {
  const handleClick = useCallback(() => {
    onToggle(field, value)
  }, [onToggle, field, value])

  return (
    <button
      type="button"
      className={`flex items-center justify-between rounded-sm px-2 py-1 text-xs transition-colors hover:bg-accent ${selected ? 'bg-accent font-medium' : ''}`}
      onClick={handleClick}
    >
      <span className="truncate">{value}</span>
      <Badge variant="secondary" className="ml-2 text-[10px]">
        {count}
      </Badge>
    </button>
  )
}

export function FacetSidebar({ facets, filters, onFilterChange }: FacetSidebarProps) {
  function getFilteredValues(field: string): string[] {
    const fieldFilter = filters.fields?.[field]
    if (!fieldFilter) return []
    const values = (fieldFilter as { in?: unknown }).in
    return Array.isArray(values) ? values.map(String) : []
  }

  function isSelected(field: string, value: string): boolean {
    return getFilteredValues(field).includes(value)
  }

  function toggleFacetValue(field: string, value: string) {
    const current = getFilteredValues(field)

    let next: string[]
    if (current.includes(value)) {
      next = current.filter(v => v !== value)
    } else {
      next = [...current, value]
    }

    const fields = { ...filters.fields }

    if (next.length === 0) {
      delete fields[field]
    } else {
      fields[field] = { in: next }
    }

    if (Object.keys(fields).length === 0) {
      onFilterChange({})
    } else {
      onFilterChange({ fields })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {Object.entries(facets).map(([field, facet]) => {
        const entries = Object.entries(facet.values).sort(([, a], [, b]) => b - a)
        if (entries.length === 0) return null

        return (
          <div key={field}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{field}</h4>
            <div className="flex flex-col gap-0.5">
              {entries.map(([value, count]) => (
                <FacetValueButton
                  key={value}
                  field={field}
                  value={value}
                  count={count}
                  selected={isSelected(field, value)}
                  onToggle={toggleFacetValue}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
