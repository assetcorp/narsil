import type { Hit } from '@delali/narsil'
import { useCallback } from 'react'
import { type DisplayFieldMapping, displayHeading } from '../../lib/display-fields'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { ResultDetail } from './ResultDetail'

interface HitDetailSheetProps {
  hit: Hit | null
  displayFields: DisplayFieldMapping | null
  onClose: () => void
}

export function HitDetailSheet({ hit, displayFields, onClose }: HitDetailSheetProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose()
    },
    [onClose],
  )

  const title = hit === null ? '' : displayHeading(hit.document, displayFields, hit.id)

  return (
    <Sheet open={hit !== null} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate">{title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-6">{hit === null ? null : <ResultDetail hit={hit} />}</div>
      </SheetContent>
    </Sheet>
  )
}
