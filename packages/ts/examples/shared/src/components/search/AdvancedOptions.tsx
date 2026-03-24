import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import type { SearchParams } from '../../hooks/use-search'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

interface AdvancedOptionsProps {
  params: SearchParams
  searchableFields: string[]
  allFields: string[]
  onFieldsChange: (fields: string[]) => void
  onBoostChange: (field: string, value: number) => void
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
  onParamChange: <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void
}

export function AdvancedOptions({
  params,
  searchableFields,
  allFields,
  onFieldsChange,
  onBoostChange,
  onSortChange,
  onParamChange,
}: AdvancedOptionsProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-4">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        Advanced options
      </button>

      {open && (
        <div className="mt-3 grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="mb-1.5 block text-xs font-medium">Search fields</span>
            <div className="flex flex-wrap gap-1">
              {searchableFields.map(field => {
                const active = params.fields.length === 0 || params.fields.includes(field)
                return (
                  <Badge
                    key={field}
                    variant={active ? 'default' : 'outline'}
                    className="cursor-pointer text-[10px]"
                    onClick={() => {
                      if (params.fields.length === 0) {
                        onFieldsChange(searchableFields.filter(f => f !== field))
                      } else if (params.fields.includes(field)) {
                        const next = params.fields.filter(f => f !== field)
                        onFieldsChange(next.length === searchableFields.length ? [] : next)
                      } else {
                        onFieldsChange([...params.fields, field])
                      }
                    }}
                  >
                    {field}
                  </Badge>
                )
              })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Field boosts</span>
            <div className="flex flex-col gap-1.5">
              {searchableFields.map(field => (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-16 truncate text-xs text-muted-foreground">{field}</span>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    step="0.5"
                    value={params.boost[field] ?? 1}
                    onChange={e => onBoostChange(field, parseFloat(e.target.value))}
                    className="h-1.5 flex-1 accent-primary"
                  />
                  <span className="w-6 text-right font-mono text-[10px]">{(params.boost[field] ?? 1).toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="fuzzy-tolerance" className="mb-1.5 block text-xs font-medium">
              Fuzzy tolerance
            </label>
            <div className="flex items-center gap-2">
              <input
                id="fuzzy-tolerance"
                type="range"
                min="0"
                max="3"
                step="1"
                value={params.tolerance}
                onChange={e => onParamChange('tolerance', parseInt(e.target.value, 10))}
                className="h-1.5 flex-1 accent-primary"
              />
              <span className="w-4 text-right font-mono text-xs">{params.tolerance}</span>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Term match</span>
            <div className="flex gap-1">
              {(['any', 'all'] as const).map(mode => (
                <Button
                  key={mode}
                  variant={params.termMatch === mode ? 'default' : 'outline'}
                  size="xs"
                  onClick={() => onParamChange('termMatch', mode)}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Exact match</span>
            <Button
              variant={params.exact ? 'default' : 'outline'}
              size="xs"
              onClick={() => onParamChange('exact', !params.exact)}
            >
              {params.exact ? 'On' : 'Off'}
            </Button>
          </div>

          <div>
            <label htmlFor="min-score" className="mb-1.5 block text-xs font-medium">
              Min score
            </label>
            <Input
              id="min-score"
              type="number"
              min="0"
              step="0.1"
              value={params.minScore || ''}
              onChange={e => onParamChange('minScore', parseFloat(e.target.value) || 0)}
              className="h-7 text-xs"
              placeholder="0"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Sort by</span>
            <div className="flex flex-wrap gap-1">
              {allFields
                .filter(f => !searchableFields.includes(f))
                .map(field => {
                  const dir = params.sort[field]
                  return (
                    <Badge
                      key={field}
                      variant={dir ? 'default' : 'outline'}
                      className="cursor-pointer text-[10px]"
                      onClick={() => {
                        if (!dir) onSortChange(field, 'desc')
                        else if (dir === 'desc') onSortChange(field, 'asc')
                        else onSortChange(field, null)
                      }}
                    >
                      {field} {dir === 'asc' ? '\u2191' : dir === 'desc' ? '\u2193' : ''}
                    </Badge>
                  )
                })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Results per page</span>
            <div className="flex gap-1">
              {[10, 20, 50].map(n => (
                <Button
                  key={n}
                  variant={params.limit === n ? 'default' : 'outline'}
                  size="xs"
                  onClick={() => onParamChange('limit', n)}
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
