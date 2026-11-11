import { LoaderCircle } from 'lucide-react'

export function PageLoading() {
  return (
    <div className="mx-auto flex max-w-6xl items-center justify-center gap-3 px-4 py-24 text-sm text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
      <output>Loading the app in your browser</output>
    </div>
  )
}
