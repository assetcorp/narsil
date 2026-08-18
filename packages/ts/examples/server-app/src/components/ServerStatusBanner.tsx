import { Loader2, TriangleAlert } from 'lucide-react'

export interface ServerStatusBannerProps {
  isConnecting: boolean
  error: string | null
}

export default function ServerStatusBanner({ isConnecting, error }: ServerStatusBannerProps) {
  if (isConnecting) {
    return (
      <div className="border-b bg-muted/40">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <p>Reaching the Narsil server. Datasets unlock as soon as it answers.</p>
        </div>
      </div>
    )
  }

  if (error !== null) {
    return (
      <div className="border-b border-destructive/30 bg-destructive/10">
        <div className="mx-auto flex max-w-6xl items-start gap-2 px-4 py-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <p className="font-medium">The Narsil server is not answering.</p>
            <p className="mt-0.5 text-destructive/80">{error}</p>
            <p className="mt-0.5">It may still be recovering saved indexes. Check the terminal output.</p>
          </div>
        </div>
      </div>
    )
  }

  return null
}
