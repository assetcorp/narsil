import { Badge } from '../ui/badge'

interface SchemaDisplayProps {
  schema: Record<string, unknown>
}

const TYPE_COLORS: Record<string, string> = {
  string: 'bg-chart-1/15 text-foreground',
  number: 'bg-chart-2/15 text-foreground',
  boolean: 'bg-chart-5/15 text-foreground',
  enum: 'bg-chart-3/25 text-foreground',
  'string[]': 'bg-chart-1/15 text-foreground',
  'number[]': 'bg-chart-2/15 text-foreground',
  'enum[]': 'bg-chart-3/25 text-foreground',
}

function renderSchema(schema: Record<string, unknown>, depth: number): React.ReactNode {
  return (
    <div className="flex flex-col">
      {Object.entries(schema).map(([field, type]) => {
        const isObject = typeof type === 'object' && type !== null

        return (
          <div key={field} className="border-b last:border-b-0" style={{ paddingLeft: depth * 16 }}>
            <div className="flex items-center gap-2 py-1.5 px-3">
              <span className="font-mono text-xs font-medium">{field}</span>
              {isObject ? (
                <Badge variant="outline" className="text-[10px]">
                  object
                </Badge>
              ) : (
                <Badge className={`text-[10px] ${TYPE_COLORS[String(type)] ?? ''}`}>{String(type)}</Badge>
              )}
            </div>
            {isObject && renderSchema(type as Record<string, unknown>, depth + 1)}
          </div>
        )
      })}
    </div>
  )
}

export function SchemaDisplay({ schema }: SchemaDisplayProps) {
  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Schema</h3>
        <p className="text-xs text-muted-foreground">{Object.keys(schema).length} top-level fields</p>
      </div>
      {renderSchema(schema, 0)}
    </div>
  )
}
