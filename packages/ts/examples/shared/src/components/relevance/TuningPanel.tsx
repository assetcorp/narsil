import type { BM25Config } from '../../scoring'
import { Button } from '../ui/button'
import { Slider } from '../ui/slider'

interface TuningPanelProps {
  config: BM25Config
  fields: string[]
  onK1Change: (k1: number) => void
  onBChange: (b: number) => void
  onFieldBoostChange: (field: string, boost: number) => void
  onReset: () => void
}

export function TuningPanel({ config, fields, onK1Change, onBChange, onFieldBoostChange, onReset }: TuningPanelProps) {
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
            <span className="text-xs font-medium">k1 (term saturation)</span>
            <span className="font-mono text-xs">{config.k1.toFixed(2)}</span>
          </div>
          <Slider
            min={0}
            max={3}
            step={0.05}
            value={[config.k1]}
            onValueChange={([v]) => onK1Change(v)}
            className="mt-2"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">Higher values let repeated terms contribute more</p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">b (length normalization)</span>
            <span className="font-mono text-xs">{config.b.toFixed(2)}</span>
          </div>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[config.b]}
            onValueChange={([v]) => onBChange(v)}
            className="mt-2"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">Higher values penalize longer documents more</p>
        </div>

        <div>
          <span className="text-xs font-medium">Field Boosts</span>
          <div className="mt-2 flex flex-col gap-3">
            {fields.map(field => {
              const boost = config.fieldBoosts[field] ?? 1
              return (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-16 truncate text-[10px] text-muted-foreground">{field}</span>
                  <Slider
                    min={0}
                    max={5}
                    step={0.5}
                    value={[boost]}
                    onValueChange={([v]) => onFieldBoostChange(field, v)}
                    className="flex-1"
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
