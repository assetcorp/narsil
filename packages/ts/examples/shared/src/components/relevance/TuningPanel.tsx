import { Button } from '../ui/button'
import type { BM25Config } from '../../scoring'

interface TuningPanelProps {
  config: BM25Config
  fields: string[]
  onK1Change: (k1: number) => void
  onBChange: (b: number) => void
  onFieldBoostChange: (field: string, boost: number) => void
  onReset: () => void
}

export function TuningPanel({
  config,
  fields,
  onK1Change,
  onBChange,
  onFieldBoostChange,
  onReset,
}: TuningPanelProps) {
  return (
    <div className="sticky top-20 rounded-lg border">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-semibold">BM25 Tuning</h3>
        <Button variant="ghost" size="xs" onClick={onReset}>
          Reset
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">k1 (term saturation)</label>
            <span className="font-mono text-xs">{config.k1.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="3"
            step="0.05"
            value={config.k1}
            onChange={(e) => onK1Change(parseFloat(e.target.value))}
            className="mt-1 h-1.5 w-full accent-primary"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Higher values let repeated terms contribute more
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">b (length normalization)</label>
            <span className="font-mono text-xs">{config.b.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={config.b}
            onChange={(e) => onBChange(parseFloat(e.target.value))}
            className="mt-1 h-1.5 w-full accent-primary"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Higher values penalize longer documents more
          </p>
        </div>

        <div>
          <label className="text-xs font-medium">Field Boosts</label>
          <div className="mt-2 flex flex-col gap-2">
            {fields.map((field) => {
              const boost = config.fieldBoosts[field] ?? 1
              return (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-16 truncate text-[10px] text-muted-foreground">
                    {field}
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    step="0.5"
                    value={boost}
                    onChange={(e) => onFieldBoostChange(field, parseFloat(e.target.value))}
                    className="h-1.5 flex-1 accent-primary"
                  />
                  <span className="w-6 text-right font-mono text-[10px]">{boost.toFixed(1)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
