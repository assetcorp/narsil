import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { countChangedSearchOptions, type SearchFormValues } from '../../hooks/use-search-form'
import type { SchemaField } from '../../lib/field-filters'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { MatchingOptions } from './MatchingOptions'
import { ResultOptions } from './ResultOptions'

type ValueSetter = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void

interface SearchOptionsProps {
  values: SearchFormValues
  fields: SchemaField[]
  searchableFields: string[]
  sortableFields: string[]
  groupTotals: boolean
  canRerank: boolean
  onFieldsChange: (fields: string[]) => void
  onBoostChange: (field: string, value: number) => void
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
  onValueChange: ValueSetter
}

export function SearchOptions({
  values,
  fields,
  searchableFields,
  sortableFields,
  groupTotals,
  canRerank,
  onFieldsChange,
  onBoostChange,
  onSortChange,
  onValueChange,
}: SearchOptionsProps) {
  const [open, setOpen] = useState(false)
  const changed = countChangedSearchOptions(values)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 rounded-lg border" data-testid="search-options">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
        <ChevronDown className="size-3.5 shrink-0 transition-transform" />
        <span className="text-foreground">Search options</span>
        {changed > 0 ? <span data-testid="search-options-changed">· {changed} changed</span> : null}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="flex flex-col gap-6 border-t p-4">
          <section aria-labelledby="search-options-matching" className="flex flex-col gap-3">
            <h3 id="search-options-matching" className="text-xs font-semibold uppercase tracking-wider">
              Matching
            </h3>
            <MatchingOptions
              values={values}
              searchableFields={searchableFields}
              onFieldsChange={onFieldsChange}
              onBoostChange={onBoostChange}
              onValueChange={onValueChange}
            />
          </section>

          <section aria-labelledby="search-options-results" className="flex flex-col gap-3 border-t pt-6">
            <h3 id="search-options-results" className="text-xs font-semibold uppercase tracking-wider">
              Results
            </h3>
            <ResultOptions
              values={values}
              fields={fields}
              searchableFields={searchableFields}
              sortableFields={sortableFields}
              groupTotals={groupTotals}
              canRerank={canRerank}
              onSortChange={onSortChange}
              onValueChange={onValueChange}
            />
          </section>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
