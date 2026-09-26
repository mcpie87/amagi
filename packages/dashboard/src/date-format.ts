import { useSyncExternalStore } from 'react'
import { DEFAULT_DATE_FORMAT } from './format.ts'

const STORAGE_KEY = 'amagi:date-format'

function readPref(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_DATE_FORMAT
  } catch {
    return DEFAULT_DATE_FORMAT
  }
}

let pref = readPref()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setDateFormatPref(value: string) {
  pref = value
  try {
    if (value === DEFAULT_DATE_FORMAT) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Storage may be unavailable, in which case the choice applies until reload.
  }
  for (const listener of listeners) listener()
}

export function useDateFormatPref(): string {
  return useSyncExternalStore(subscribe, () => pref)
}
