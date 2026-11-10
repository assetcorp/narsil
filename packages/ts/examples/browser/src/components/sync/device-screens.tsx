import { Lock, NotebookPen, RotateCw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { DevicePicker } from './device-picker'
import { Notice } from './notice'

function reloadPage() {
  window.location.reload()
}

function RetryButton() {
  return (
    <Button type="button" variant="ghost" className="w-full" onClick={reloadPage}>
      <RotateCw aria-hidden="true" />
      Try again
    </Button>
  )
}

function ScreenFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-12 stagger-in">{children}</div>
}

export function OnboardingScreen({ rejectedName, onPick }: { rejectedName?: string; onPick: (name: string) => void }) {
  return (
    <ScreenFrame>
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <NotebookPen className="size-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg leading-tight font-bold">Personal notes</h1>
          <p className="text-sm text-muted-foreground">A Narsil device sync example</p>
        </div>
      </div>
      {rejectedName === undefined ? null : (
        <Notice
          icon={<TriangleAlert />}
          tone="destructive"
          urgent
          title={`'${rejectedName}' is not a usable device name`}
        >
          Pick one of the devices below or enter a valid name.
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Name this device</CardTitle>
          <CardDescription>
            Each device keeps a separate copy of your notes in this browser, and the server keeps the copies in step.
            Open this page in a second tab under another name to add a second device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DevicePicker onPick={onPick} />
        </CardContent>
      </Card>
    </ScreenFrame>
  )
}

export function LockedScreen({ name, onPick }: { name: string; onPick: (name: string) => void }) {
  return (
    <ScreenFrame>
      <Notice
        icon={<Lock />}
        urgent
        title={
          <>
            Device <span className="font-mono">{name}</span> is open in another tab
          </>
        }
      >
        Two tabs on one device would share one local copy, which looks like sync but is a single copy in two windows.
        Close the other tab, or open this tab as a different device.
      </Notice>
      <Card>
        <CardHeader>
          <CardTitle>Use another device here</CardTitle>
          <CardDescription>Every device below keeps a separate copy of your notes in this browser.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DevicePicker onPick={onPick} />
          <RetryButton />
        </CardContent>
      </Card>
    </ScreenFrame>
  )
}

export function FailedScreen({ name, failure }: { name: string; failure: string }) {
  return (
    <ScreenFrame>
      <Notice
        icon={<TriangleAlert />}
        tone="destructive"
        urgent
        title={
          <>
            Device <span className="font-mono">{name}</span> could not open
          </>
        }
      >
        {failure}
      </Notice>
      <RetryButton />
    </ScreenFrame>
  )
}
