import { Loader2, TriangleAlert } from 'lucide-react'
import type { EngineStatus } from '../lib/engine-status'

export default function EngineStatusBanner({ status }: { status: EngineStatus }) {
  if (status.phase === 'starting') {
    return (
      <div className="border-b bg-muted/40">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <p>Narsil is restoring saved indexes from disk. Datasets unlock as soon as recovery finishes.</p>
        </div>
      </div>
    )
  }

  if (status.phase === 'error') {
    return (
      <div className="border-b border-destructive/30 bg-destructive/10">
        <div className="mx-auto flex max-w-6xl items-start gap-2 px-4 py-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <p className="font-medium">The bundled Narsil server failed to start.</p>
            {status.error && <p className="mt-0.5 text-destructive/80">{status.error}</p>}
            <p className="mt-0.5">Check the terminal output, fix the cause, and restart the dev server.</p>
          </div>
        </div>
      </div>
    )
  }

  return null
}
