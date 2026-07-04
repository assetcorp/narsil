import { Separator } from '#/components/ui/separator'

export default function Footer() {
  return (
    <footer className="mt-auto border-t px-4 py-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-xs text-muted-foreground sm:flex-row">
        <p className="m-0">Narsil &mdash; open-source distributed search engine for text and vectors</p>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/assetcorp/narsil"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <Separator orientation="vertical" className="h-3" />
          <a
            href="https://www.npmjs.com/package/@delali/narsil"
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            npm
          </a>
          <Separator orientation="vertical" className="h-3" />
          <span>Apache-2.0</span>
        </div>
      </div>
    </footer>
  )
}
