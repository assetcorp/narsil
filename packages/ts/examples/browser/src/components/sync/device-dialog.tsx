import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@delali/narsil-example-shared/ui/dialog'
import { Link } from '@tanstack/react-router'
import { ChevronsUpDown, ExternalLink, Smartphone } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Button } from '#/components/ui/button'
import { DevicePicker } from './device-picker'

export function DeviceDialog({ currentDevice, onPick }: { currentDevice: string; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false)

  const pick = useCallback(
    (name: string) => {
      setOpen(false)
      if (name !== currentDevice) onPick(name)
    },
    [currentDevice, onPick],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Device ${currentDevice}. Switch device`}>
          <Smartphone aria-hidden="true" />
          <span className="max-w-32 truncate font-mono text-xs">{currentDevice}</span>
          <ChevronsUpDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Switch device</DialogTitle>
          <DialogDescription>
            This tab is <span className="font-mono">{currentDevice}</span>. Switching opens another device's copy of
            your notes, and any edits that this device has not uploaded yet stay queued in this browser.
          </DialogDescription>
        </DialogHeader>
        <DevicePicker currentDevice={currentDevice} onPick={pick} />
        <Button asChild variant="ghost" className="w-full">
          <Link to="/sync" target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            Open another device in a new tab
          </Link>
        </Button>
      </DialogContent>
    </Dialog>
  )
}
