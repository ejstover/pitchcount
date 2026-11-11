import { describe, expect, it } from 'vitest'
import { catalog } from './catalog'
import { awardExplanation } from './descriptions'

describe('award explanations', () => {
  it('gives every award a short, readable explanation', () => {
    for (const award of catalog) {
      const explanation = awardExplanation(award)
      expect(explanation, award.title).toBeTypeOf('string')
      expect(explanation.length, award.title).toBeGreaterThan(20)
      expect(explanation.length, award.title).toBeLessThan(140)
      expect(explanation, award.title).not.toMatch(/undefined|\{n\}/)
    }
  })

  it('explains the difference between similar goals without changing their targets', () => {
    expect(awardExplanation(catalog.find(d => d.family === 25)!)).toContain('at or below')
    expect(awardExplanation(catalog.find(d => d.family === 57)!)).toContain('warm-up')
    expect(awardExplanation(catalog.find(d => d.family === 60)!)).toContain('rest day in advance')
    expect(awardExplanation(catalog.find(d => d.family === 80)!)).toContain('same season')
    expect(new Set(catalog.map(awardExplanation)).size).toBe(80)
  })
})
