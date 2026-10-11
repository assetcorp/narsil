import { MAX_LATITUDE_DEGREES, MAX_LONGITUDE_DEGREES } from './constants'

export function isLatitude(value: number): boolean {
  return value >= -MAX_LATITUDE_DEGREES && value <= MAX_LATITUDE_DEGREES
}

export function isLongitude(value: number): boolean {
  return value >= -MAX_LONGITUDE_DEGREES && value <= MAX_LONGITUDE_DEGREES
}
