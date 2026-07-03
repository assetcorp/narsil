import { createFileRoute } from '@tanstack/react-router'
import { AskView } from '#/components/ask/AskView'

export const Route = createFileRoute('/ask')({ component: AskView })
