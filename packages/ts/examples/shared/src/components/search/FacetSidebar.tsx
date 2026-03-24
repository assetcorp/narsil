import { Badge } from '../ui/badge'

interface FacetSidebarProps {
  facets: Record<string, { values: Record<string, number>; count: number }>
  filters: Record<string, unknown>
  onFilterChange: (filters: Record<string, unknown>) => void
}

export function FacetSidebar({ facets, filters, onFilterChange }: FacetSidebarProps) {
  function getFilteredValues(field: string): string[] {
    const fieldsObj = (filters as Record<string, Record<string, Record<string, string[]>>>).fields
    if (!fieldsObj) return []
    const fieldFilter = fieldsObj[field]
    if (!fieldFilter) return []
    return fieldFilter.in ?? []
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

    const existingFields = (filters as Record<string, Record<string, unknown>>).fields ?? {}
    const fields: Record<string, unknown> = { ...existingFields }

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
              {entries.map(([value, count]) => {
                const selected = isSelected(field, value)
                return (
                  <button
                    key={value}
                    type="button"
                    className={`flex items-center justify-between rounded-sm px-2 py-1 text-xs transition-colors hover:bg-accent ${selected ? 'bg-accent font-medium' : ''}`}
                    onClick={() => toggleFacetValue(field, value)}
                  >
                    <span className="truncate">{value}</span>
                    <Badge variant="secondary" className="ml-2 text-[10px]">
                      {count}
                    </Badge>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
