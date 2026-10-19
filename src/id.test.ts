import { expect, it, vi } from 'vitest'
import { createId } from './id'

it('can create distinct UUIDs when randomUUID is unavailable on a LAN URL', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto)
  vi.stubGlobal('crypto', { getRandomValues })
  try {
    const first = createId(), second = createId()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first).not.toBe(second)
  } finally { vi.unstubAllGlobals() }
})
