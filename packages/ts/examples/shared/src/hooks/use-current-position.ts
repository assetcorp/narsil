import { useCallback, useEffect, useRef, useState } from 'react'
import { type GeoPoint, roundCoordinate } from '../lib/geo-shapes'

const POSITION_TIMEOUT_MS = 10_000
const POSITION_MAX_AGE_MS = 300_000

interface CurrentPositionState {
  locate: () => void
  isLocating: boolean
  error: string | null
}

function describeFailure(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) {
    return 'The browser blocks location for this site. Allow it in the site settings, or type a centre.'
  }
  if (error.code === error.TIMEOUT) return 'The browser took too long to find your location. Try again.'
  return 'The browser could not find your location. Type a centre instead.'
}

function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext
}

export type PositionRequest = 'asked' | 'already-allowed'

export function useCurrentPosition(onFound: (point: GeoPoint, request: PositionRequest) => void): CurrentPositionState {
  const [isLocating, setIsLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onFoundRef = useRef(onFound)
  onFoundRef.current = onFound

  const requestPosition = useCallback((request: PositionRequest) => {
    if (!geolocationAvailable()) {
      if (request === 'asked') setError('This browser cannot share a location here. Type a centre instead.')
      return
    }
    setIsLocating(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      position => {
        setIsLocating(false)
        onFoundRef.current(
          { lat: roundCoordinate(position.coords.latitude), lon: roundCoordinate(position.coords.longitude) },
          request,
        )
      },
      failure => {
        setIsLocating(false)
        if (request === 'asked') setError(describeFailure(failure))
      },
      { enableHighAccuracy: false, timeout: POSITION_TIMEOUT_MS, maximumAge: POSITION_MAX_AGE_MS },
    )
  }, [])

  const locate = useCallback(() => {
    requestPosition('asked')
  }, [requestPosition])

  useEffect(() => {
    if (!geolocationAvailable() || navigator.permissions === undefined) return
    let cancelled = false
    navigator.permissions
      .query({ name: 'geolocation' })
      .then(status => {
        if (!cancelled && status.state === 'granted') requestPosition('already-allowed')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [requestPosition])

  return { locate, isLocating, error }
}
