import { expect, it } from 'vitest'
import { canApplyUpdate } from './update-policy'

it('allows an update only when practice, saves, notes, and forms are settled', () => {
  expect(canApplyUpdate(false, 0, false, false, false)).toBe(true)
  expect(canApplyUpdate(true, 0, false, false, false)).toBe(false)
  expect(canApplyUpdate(false, 1, false, false, false)).toBe(false)
  expect(canApplyUpdate(false, 0, true, false, false)).toBe(false)
  expect(canApplyUpdate(false, 0, false, true, false)).toBe(false)
  expect(canApplyUpdate(false, 0, false, false, true)).toBe(false)
})
