import { KeyRound, TriangleAlert } from 'lucide-react'
import { Card, CardContent } from '#/components/ui/card'
import type { AskCapabilities } from '#/lib/ask/types'

interface SetupNoticeProps {
  capabilities: AskCapabilities | null
  capabilitiesError: string | null
}

/**
 * Explains exactly what to configure when answer generation cannot run. The
 * page never hides behind a spinner or crashes; it says what is missing and
 * which environment variable fixes it.
 */
export function SetupNotice({ capabilities, capabilitiesError }: SetupNoticeProps) {
  if (capabilitiesError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-start gap-3 py-4">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium">The Ask configuration could not be read.</p>
            <p className="mt-1 text-muted-foreground">{capabilitiesError}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!capabilities || capabilities.llmConfigured) return null

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex items-start gap-3 py-4">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium">Bring your own model to ask questions.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code className="rounded bg-muted px-1 font-mono text-xs">OPENAI_API_KEY</code> in the app server
            environment and restart <code className="rounded bg-muted px-1 font-mono text-xs">pnpm dev</code>. Any
            OpenAI-compatible endpoint works via{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">ASK_LLM_BASE_URL</code> and{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">ASK_LLM_MODEL</code>. The same key enables
            semantic and hybrid retrieval when you reload a dataset.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
