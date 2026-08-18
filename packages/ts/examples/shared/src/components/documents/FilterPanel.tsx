import { Plus, X } from 'lucide-react'
import { useCallback } from 'react'
import {
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
  onChange: (rules: FilterRule[]) => void
}

interface FilterRowProps {
  rule: FilterRule
  fields: SchemaField[]
  onChange: (rule: FilterRule) => void
  onRemove: (id: string) => void
}

const BOOLEAN_CHOICES = ['true', 'false']

const CONTROL_SURFACE = 'w-full bg-card text-xs'

function FilterRow({ rule, fields, onChange, onRemove }: FilterRowProps) {
  const field = fields.find(entry => entry.path === rule.field)
  const operators = field ? operatorsFor(field.type) : []
  const arity = operatorArity(rule.operator)
  const isBoolean = field?.type === 'boolean' || field?.type === 'boolean[]'
  const isNumeric = field?.type === 'number' || field?.type === 'number[]'

  const handleFieldChange = useCallback(
    (path: string) => {
      const next = fields.find(entry => entry.path === path)
      const allowed = next ? operatorsFor(next.type) : []
      const operator = allowed.includes(rule.operator) ? rule.operator : (allowed[0] ?? 'eq')
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

  const handleRemove = useCallback(() => {
    onRemove(rule.id)
  }, [onRemove, rule.id])

  return (
    <div className="rounded-lg border bg-surface-raised p-3">
      <div className="flex items-start gap-2 sm:items-center">
        <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,1.25fr)] sm:items-center">
          <Select value={rule.field} onValueChange={handleFieldChange}>
            <SelectTrigger className={`${CONTROL_SURFACE} font-mono`}>
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
            <SelectTrigger className={CONTROL_SURFACE}>
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

          {arity === 'none' ? null : isBoolean ? (
            <Select value={rule.value} onValueChange={handleBooleanChange}>
              <SelectTrigger className={CONTROL_SURFACE}>
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
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={rule.value}
                onChange={handleValueChange}
                inputMode={isNumeric ? 'decimal' : 'text'}
                placeholder={arity === 'list' ? 'Values separated by commas' : 'Value'}
                className={CONTROL_SURFACE}
              />
              {arity === 'two' ? (
                <Input
                  value={rule.upperValue}
                  onChange={handleUpperChange}
                  inputMode="decimal"
                  placeholder="Upper bound"
                  className={CONTROL_SURFACE}
                />
              ) : null}
            </div>
          )}
        </div>

        <Button type="button" variant="ghost" size="icon-sm" onClick={handleRemove}>
          <X className="size-3.5" />
          <span className="sr-only">Remove this condition</span>
        </Button>
      </div>
    </div>
  )
}

export function FilterPanel({ fields, rules, onChange }: FilterPanelProps) {
  const handleAdd = useCallback(() => {
    const first = fields[0]
    if (!first) return
    const operator = operatorsFor(first.type)[0] ?? 'eq'
    const id = `rule-${rules.length}-${first.path}-${operator}`
    onChange([...rules, { id, field: first.path, operator, value: '', upperValue: '' }])
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
      <p className="text-xs text-muted-foreground">
        Every condition has to match. The engine applies them before it reads a page, so the count reflects the whole
        index.
      </p>

      {rules.map(rule => (
        <FilterRow key={rule.id} rule={rule} fields={fields} onChange={handleRuleChange} onRemove={handleRuleRemove} />
      ))}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="size-3.5" />
          Add condition
        </Button>
        {rules.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
            Clear all
          </Button>
        ) : null}
      </div>
    </div>
  )
}
