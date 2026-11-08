import { ArrowRight, HardDrive, Plus } from 'lucide-react'
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  DEVICE_NAME_RULE,
  isValidDeviceName,
  listDevicesHeldElsewhere,
  listKnownDevices,
  normaliseDeviceName,
} from './device-registry'

function DeviceNameForm({ label, onPick }: { label: string; onPick: (name: string) => void }) {
  const inputId = useId()
  const ruleId = useId()
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)

  const changeDraft = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value)
    setInvalid(false)
  }, [])

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const name = normaliseDeviceName(draft)
      if (!isValidDeviceName(name)) {
        setInvalid(true)
        return
      }
      onPick(name)
    },
    [draft, onPick],
  )

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draft}
          onChange={changeDraft}
          placeholder="laptop"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={invalid}
          aria-describedby={ruleId}
        />
        <Button type="submit">
          <Plus aria-hidden="true" />
          Open
        </Button>
      </div>
      <p id={ruleId} className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {DEVICE_NAME_RULE}
      </p>
    </form>
  )
}

function DeviceRow({
  name,
  current,
  heldElsewhere,
  onPick,
}: {
  name: string
  current: boolean
  heldElsewhere: boolean
  onPick: (name: string) => void
}) {
  const pick = useCallback(() => onPick(name), [name, onPick])
  return (
    <li>
      <Button variant="outline" className="w-full justify-start" disabled={current || heldElsewhere} onClick={pick}>
        <HardDrive className="text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-mono">{name}</span>
        {current ? <Badge variant="secondary">this tab</Badge> : null}
        {heldElsewhere && !current ? <Badge variant="secondary">open in another tab</Badge> : null}
        <ArrowRight className="ml-auto text-muted-foreground" aria-hidden="true" />
      </Button>
    </li>
  )
}

export function DevicePicker({ currentDevice, onPick }: { currentDevice?: string; onPick: (name: string) => void }) {
  const [knownDevices, setKnownDevices] = useState<string[]>([])
  const [heldElsewhere, setHeldElsewhere] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    setKnownDevices(listKnownDevices())
    let cancelled = false
    void listDevicesHeldElsewhere().then(held => {
      if (!cancelled) setHeldElsewhere(held)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-5">
      {knownDevices.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Devices in this browser</p>
          <ul className="flex flex-col gap-2">
            {knownDevices.map(name => (
              <DeviceRow
                key={name}
                name={name}
                current={name === currentDevice}
                heldElsewhere={heldElsewhere.has(name)}
                onPick={onPick}
              />
            ))}
          </ul>
        </div>
      ) : null}
      <DeviceNameForm label={knownDevices.length > 0 ? 'Or add a new device' : 'Device name'} onPick={onPick} />
    </div>
  )
}
