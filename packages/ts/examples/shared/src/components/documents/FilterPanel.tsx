import { Plus, X } from 'lucide-react'
import { useCallback, useRef } from 'react'
import {
  acceptsCaseFold,
  type FilterJoin,
  type FilterOperatorId,
  type FilterRule,
  OPERATOR_LABELS,
  operatorArity,
  operatorsFor,
  type SchemaField,
} from '../../lib/field-filters'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

interface FilterPanelProps {
  fields: SchemaField[]
  rules: FilterRule[]
  join: FilterJoin
  onChange: (rules: FilterRule[]) => void
  onJoinChange: (join: FilterJoin) => void
}

interface FilterRowProps {
  rule: FilterRule
  fields: SchemaField[]
  onChange: (rule: FilterRule) => void
  onRemove: (id: string) => void
}

const BOOLEAN_CHOICES = ['true', 'false']
const FILTER_JOINS: FilterJoin[] = ['and', 'or']

const CONTROL_SURFACE = 'w-full bg-card text-xs'

const JOIN_DESCRIPTIONS: Record<FilterJoin, string> = {
  and: 'Every condition has to match.',
  or: 'Any one condition can match.',
}

function FilterValueInput({
  rule,
  field,
  onChange,
}: {
  rule: FilterRule
  field: SchemaField | undefined
  onChange: (rule: FilterRule) => void
}) {
  const arity = operatorArity(rule.operator)
  const isBoolean = field?.type === 'boolean' || field?.type === 'boolean[]'
  const isNumeric = field?.type === 'number' || field?.type === 'number[]'

  const handleValueChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...rule, value: event.target.value })
    },
    [onChange, rule],
  )

  const handleBooleanChange = useCallback(
    (value: string) => {
      onChange({ ...rule, value })
    },
    [onChange, rule],
  )

  const handleUpperChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...rule, upperValue: event.target.value })
    },
    [onChange, rule],
  )

  if (arity === 'none') return <span />

  if (isBoolean) {
    return (
      <Select value={rule.value} onValueChange={handleBooleanChange}>
        <SelectTrigger className={CONTROL_SURFACE} aria-label="Value">
          <SelectValue placeholder="true or false" />
        </SelectTrigger>
        <SelectContent>
          {BOOLEAN_CHOICES.map(choice => (
            <SelectItem key={choice} value={choice} className="font-mono text-xs">
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={rule.value}
        onChange={handleValueChange}
        inputMode={isNumeric ? 'decimal' : 'text'}
        placeholder={arity === 'list' ? 'Values separated by commas' : 'Value'}
        aria-label="Value"
        className={CONTROL_SURFACE}
      />
      {arity === 'two' ? (
        <Input
          value={rule.upperValue}
          onChange={handleUpperChange}
          inputMode="decimal"
          placeholder="Upper bound"
          aria-label="Upper bound"
          className={CONTROL_SURFACE}
        />
      ) : null}
    </div>
  )
}

function FilterRow({ rule, fields, onChange, onRemove }: FilterRowProps) {
  const field = fields.find(entry => entry.path === rule.field)
  const operators = field ? operatorsFor(field) : []
  const showCaseFold = acceptsCaseFold(field, rule.operator)

  const handleFieldChange = useCallback(
    (path: string) => {
      const next = fields.find(entry => entry.path === path)
      const allowed = next ? operatorsFor(next) : []
      const operator = allowed.includes(rule.operator) ? rule.operator : (allowed[0] ?? 'exists')
      onChange({ ...rule, field: path, operator, value: '', upperValue: '' })
    },
    [fields, onChange, rule],
  )

  const handleOperatorChange = useCallback(
    (operator: string) => {
      onChange({ ...rule, operator: operator as FilterOperatorId, value: '', upperValue: '' })
    },
    [onChange, rule],
  )

  const handleNegateToggle = useCallback(() => {
    onChange({ ...rule, negate: !rule.negate })
  }, [onChange, rule])

  const handleCaseFoldToggle = useCallback(() => {
    onChange({ ...rule, caseFold: !rule.caseFold })
  }, [onChange, rule])

  const handleRemove = useCallback(() => {
    onRemove(rule.id)
  }, [onRemove, rule.id])

  return (
    <div className="rounded-lg border bg-surface-raised p-3" data-testid="filter-rule">
      <div className="flex items-start gap-2 sm:items-center">
        <Button
          type="button"
          variant={rule.negate ? 'default' : 'outline'}
          size="xs"
          aria-pressed={rule.negate}
          onClick={handleNegateToggle}
        >
          not
        </Button>
        <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,1.25fr)] sm:items-center">
          <Select value={rule.field} onValueChange={handleFieldChange}>
            <SelectTrigger className={`${CONTROL_SURFACE} font-mono`} aria-label="Field">
              <SelectValue placeholder="Choose a field" />
            </SelectTrigger>
            <SelectContent>
              {fields.map(entry => (
                <SelectItem key={entry.path} value={entry.path} className="font-mono text-xs">
                  {entry.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={rule.operator} onValueChange={handleOperatorChange}>
            <SelectTrigger className={CONTROL_SURFACE} aria-label="Test">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map(operator => (
                <SelectItem key={operator} value={operator} className="text-xs">
                  {OPERATOR_LABELS[operator]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <FilterValueInput rule={rule} field={field} onChange={onChange} />
        </div>

        {showCaseFold ? (
          <Button
            type="button"
            variant={rule.caseFold ? 'default' : 'outline'}
            size="xs"
            aria-pressed={rule.caseFold}
            onClick={handleCaseFoldToggle}
          >
            Ignore case
          </Button>
        ) : null}

        <Button type="button" variant="ghost" size="icon-sm" onClick={handleRemove}>
          <X className="size-3.5" />
          <span className="sr-only">Remove this condition</span>
        </Button>
      </div>
    </div>
  )
}

function JoinButton({
  join,
  active,
  onJoinChange,
}: {
  join: FilterJoin
  active: boolean
  onJoinChange: (join: FilterJoin) => void
}) {
  const handleClick = useCallback(() => {
    onJoinChange(join)
  }, [onJoinChange, join])

  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="xs"
      aria-pressed={active}
      onClick={handleClick}
    >
      {join === 'and' ? 'Match all' : 'Match any'}
    </Button>
  )
}

export function FilterPanel({ fields, rules, join, onChange, onJoinChange }: FilterPanelProps) {
  const nextRuleNumber = useRef(0)

  const handleAdd = useCallback(() => {
    const first = fields[0]
    if (!first) return
    const operator = operatorsFor(first)[0] ?? 'exists'
    nextRuleNumber.current += 1
    const id = `rule-${nextRuleNumber.current}`
    onChange([...rules, { id, field: first.path, operator, value: '', upperValue: '', negate: false, caseFold: false }])
  }, [fields, onChange, rules])

  const handleRuleChange = useCallback(
    (next: FilterRule) => {
      onChange(rules.map(rule => (rule.id === next.id ? next : rule)))
    },
    [onChange, rules],
  )

  const handleRuleRemove = useCallback(
    (id: string) => {
      onChange(rules.filter(rule => rule.id !== id))
    },
    [onChange, rules],
  )

  const handleClear = useCallback(() => {
    onChange([])
  }, [onChange])

  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">This index reports no fields to filter on.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_JOINS.map(entry => (
          <JoinButton key={entry} join={entry} active={join === entry} onJoinChange={onJoinChange} />
        ))}
        <p className="text-xs text-muted-foreground">
          {JOIN_DESCRIPTIONS[join]} The engine applies the conditions before it reads a page, so the count covers the
          whole index.
        </p>
      </div>

      {rules.map(rule => (
        <FilterRow key={rule.id} rule={rule} fields={fields} onChange={handleRuleChange} onRemove={handleRuleRemove} />
      ))}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="size-3.5" />
          Add condition
        </Button>
        {rules.length > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={handleClear}>
            Clear all
          </Button>
        ) : null}
      </div>
    </div>
  )
}
