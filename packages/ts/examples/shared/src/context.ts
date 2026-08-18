import { createContext, useContext } from 'react'

export interface CommandPaletteControls {
  open: boolean
  setOpen: (open: boolean) => void
}

export const CommandPaletteContext = createContext<CommandPaletteControls | null>(null)

export function useCommandPalette(): CommandPaletteControls {
  const controls = useContext(CommandPaletteContext)
  if (controls === null) {
    throw new Error('useCommandPalette must be used within a CommandPaletteProvider')
  }
  return controls
}
