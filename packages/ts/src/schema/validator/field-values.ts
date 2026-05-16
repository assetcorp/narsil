import { ErrorCodes, NarsilError } from '../../errors'
import type { FieldType } from '../../types/schema'
import { isPlainObject, VECTOR_PATTERN } from './shared'

export function validateGeopoint(path: string, value: unknown): void {
  if (!isPlainObject(value)) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_INVALID_GEOPOINT,
      `Field "${path}" expected a geopoint object with lat and lon`,
      {
        field: path,
        received: Array.isArray(value) ? 'array' : typeof value,
      },
    )
  }

  if (
    typeof value.lat !== 'number' ||
    typeof value.lon !== 'number' ||
    Number.isNaN(value.lat) ||
    Number.isNaN(value.lon)
  ) {
    throw new NarsilError(ErrorCodes.SCHEMA_INVALID_GEOPOINT, `Field "${path}" geopoint requires numeric lat and lon`, {
      field: path,
      lat: Number.isNaN(value.lat) ? 'NaN' : typeof value.lat,
      lon: Number.isNaN(value.lon) ? 'NaN' : typeof value.lon,
    })
  }

  if (value.lat < -90 || value.lat > 90) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_INVALID_GEOPOINT,
      `Field "${path}" geopoint lat must be between -90 and 90`,
      {
        field: path,
        lat: value.lat,
      },
    )
  }

  if (value.lon < -180 || value.lon > 180) {
    throw new NarsilError(
      ErrorCodes.SCHEMA_INVALID_GEOPOINT,
      `Field "${path}" geopoint lon must be between -180 and 180`,
      {
        field: path,
        lon: value.lon,
      },
    )
  }
}

export function validateVector(path: string, value: unknown, expectedDimension: number): void {
  const isArray = Array.isArray(value)
  const isFloat32 = value instanceof Float32Array

  if (!isArray && !isFloat32) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Field "${path}" expected a vector (Array or Float32Array)`,
      { field: path, received: typeof value },
    )
  }

  const arr = value as ArrayLike<unknown>
  if (arr.length !== expectedDimension) {
    throw new NarsilError(
      ErrorCodes.DOC_VALIDATION_FAILED,
      `Field "${path}" expected vector of dimension ${expectedDimension}, got ${arr.length}`,
      { field: path, expected: expectedDimension, received: arr.length },
    )
  }

  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'number' || Number.isNaN(arr[i])) {
      throw new NarsilError(
        ErrorCodes.DOC_VALIDATION_FAILED,
        `Field "${path}" vector element at index ${i} is not a valid number`,
        { field: path, index: i, value: arr[i] },
      )
    }
  }
}

export function validateTypedArray(path: string, value: unknown, elementType: 'string' | 'number' | 'boolean'): void {
  if (!Array.isArray(value)) {
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path}" expected an array`, {
      field: path,
      received: typeof value,
    })
  }

  for (let i = 0; i < value.length; i++) {
    const el = value[i]
    if (typeof el !== elementType) {
      throw new NarsilError(
        ErrorCodes.DOC_VALIDATION_FAILED,
        `Field "${path}" array element at index ${i} expected ${elementType}, got ${typeof el}`,
        { field: path, index: i, expected: elementType, received: typeof el },
      )
    }
    if (elementType === 'number' && Number.isNaN(el as number)) {
      throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path}" array element at index ${i} is NaN`, {
        field: path,
        index: i,
      })
    }
  }
}

export function validateFieldValue(path: string, value: unknown, type: FieldType): void {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new NarsilError(
          ErrorCodes.DOC_VALIDATION_FAILED,
          `Field "${path}" expected string, got ${typeof value}`,
          {
            field: path,
            expected: 'string',
            received: typeof value,
          },
        )
      }
      return
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path}" expected a valid number`, {
          field: path,
          expected: 'number',
          received: Number.isNaN(value) ? 'NaN' : typeof value,
        })
      }
      return
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new NarsilError(
          ErrorCodes.DOC_VALIDATION_FAILED,
          `Field "${path}" expected boolean, got ${typeof value}`,
          {
            field: path,
            expected: 'boolean',
            received: typeof value,
          },
        )
      }
      return
    case 'enum':
      if (typeof value !== 'string') {
        throw new NarsilError(
          ErrorCodes.DOC_VALIDATION_FAILED,
          `Field "${path}" expected enum (string), got ${typeof value}`,
          {
            field: path,
            expected: 'enum',
            received: typeof value,
          },
        )
      }
      return
    case 'geopoint':
      validateGeopoint(path, value)
      return
    case 'string[]':
      validateTypedArray(path, value, 'string')
      return
    case 'number[]':
      validateTypedArray(path, value, 'number')
      return
    case 'boolean[]':
      validateTypedArray(path, value, 'boolean')
      return
    case 'enum[]':
      validateTypedArray(path, value, 'string')
      return
    default: {
      const vectorMatch = VECTOR_PATTERN.exec(type)
      if (vectorMatch) {
        validateVector(path, value, Number.parseInt(vectorMatch[1], 10))
      }
    }
  }
}
