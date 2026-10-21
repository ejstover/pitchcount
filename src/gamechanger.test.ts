import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gcComparison, gcCovered, gcFingerprint, parseGameChanger, readCSV, suggestGCMatch, type GCPlayer, type GCSummary } from './gamechanger'
import { PitchDatabase, Repository } from './storage'
import { validateBackup } from './backup'
import type { Appearance, Pitcher } from './domain'
import { selectGameChangerSummaries, statisticsPitchers } from './statistics'

const csv = readFileSync('tests/fixtures/gamechanger.csv', 'utf8')
const parsed = () => parseGameChanger(csv)
const players = (): GCPlayer[] => parsed().players.map((p, i) => ({ ...p, pitcherId: `pitcher-${i}` }))
const summary = (): GCSummary => ({ id: 'summary', teamId: 'team', season: 'Fall 2026', coverageStart: '2026-09-01', coverageEnd: '2026-10-20', players: players(), teamTotals: parsed().teamTotals, warnings: parsed().warnings, fileName: 'stats.csv', revision: 1, importedBy: 'coach', importedByName: 'Coach', updatedAt: '2026-10-21T12:00:00Z', fingerprint: '' })
const encode = (rows: string[][]) => rows.map(row => row.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\n')

describe('automatic game-summary selection', () => {
  const filters = { teamId: '', pitcherId: '', range: null }
  const september = () => ({ ...summary(), coverageEnd: '2026-09-30' })
  const october = () => ({ ...summary(), id: 'october', season: 'October', coverageStart: '2026-10-01' })
  it('combines all non-overlapping seasons and teams without a season selection', () => {
    const other = { ...september(), id: 'other', teamId: 'other-team' }
    const selected = selectGameChangerSummaries([september(), october(), other], filters)
    expect(selected.included.map(s => s.id)).toEqual(['summary', 'october', 'other'])
    expect(gcComparison([], selected.included.flatMap(s => s.players)).game.total).toBe(535 * 3)
    expect(selectGameChangerSummaries(selected.included, { ...filters, teamId: 'team' }).included).toHaveLength(2)
  })
  it('excludes every conflicting summary for the same team, including shared boundary dates', () => {
    const overlap = { ...october(), coverageStart: '2026-09-30' }
    const other = { ...september(), id: 'other', teamId: 'other-team' }
    const selected = selectGameChangerSummaries([september(), overlap, other], filters)
    expect(selected.included).toEqual([other])
    expect(selected.conflicts.map(s => s.id)).toEqual(['summary', 'october'])
  })
  it('uses full date coverage, reports partial matches, and leaves unrelated periods out quietly', () => {
    const selected = selectGameChangerSummaries([september(), october()], { ...filters, range: { start: '2026-10-10', end: '2026-10-20' } })
    expect(selected.included).toEqual([])
    expect(selected.partial.map(s => s.id)).toEqual(['october'])
    expect(selectGameChangerSummaries([september(), october()], { ...filters, range: { start: '2026-10-01', end: '2026-10-20' } }).included.map(s => s.id)).toEqual(['october'])
  })
  it('only considers summaries containing the selected pitcher when checking overlap', () => {
    const other = { ...september(), id: 'other', players: [{ ...players()[0], pitcherId: 'different' }] }
    expect(selectGameChangerSummaries([september(), other], { ...filters, pitcherId: 'pitcher-0' }).included.map(s => s.id)).toEqual(['summary'])
  })
  it('filters pitchers by team roster and history, including archived and import-only pitchers', () => {
    const pitchers = ['active', 'inactive', 'history', 'import', 'unrelated'].map(id => ({ id, name: id, archived: id === 'inactive' } as Pitcher))
    const data = { pitchers, teamPitchers: [{ teamId: 'team', pitcherId: 'active', active: true }, { teamId: 'team', pitcherId: 'inactive', active: false }], sessions: [{ teamId: 'team', pitcherIds: ['history'] }] as import('./domain').Session[], gcSummaries: [{ ...summary(), players: [{ ...players()[0], pitcherId: 'import' }] }] }
    expect(statisticsPitchers(data, 'team').map(p => p.id)).toEqual(['active', 'history', 'import', 'inactive'])
    expect(statisticsPitchers(data, '')).toHaveLength(5)
    expect(statisticsPitchers(data, 'unknown')).toEqual([])
  })
})

describe('GameChanger CSV', () => {
  it('reads pitching fields by section and preserves source values and team totals', () => {
    const result = parsed()
    expect(result.players).toHaveLength(4)
    expect(result.players.reduce((n, p) => n + p.stats.pitches!, 0)).toBe(535)
    expect(result.players.reduce((n, p) => n + p.stats.walks!, 0)).toBe(18)
    expect(result.players.reduce((n, p) => n + p.stats.strikeouts!, 0)).toBe(50)
    expect(result.players[0].stats.outs).toBe(37)
    expect(result.players[0].sourceValues.MPHFB).toBe('N/A')
    expect(result.teamTotals).toMatchObject({ pitches: 535, batters: 134, games: 7 })
    expect(result.warnings).toContain('Pitcher batters total 135; GC team total 134. Pitcher comparisons use player rows.')
  })
  it('handles BOM, CRLF, quoted commas, quotes, embedded newlines and row order', () => {
    const rows = readCSV(csv); rows[2][2] = 'Pitcher, "A"\nJunior'
    expect(parseGameChanger('\uFEFF' + encode(rows).replaceAll('\n', '\r\n')).players.find(p => p.name.includes('Junior'))?.name).toContain('"A"\r\nJunior')
    const a = summary(), b = { ...a, fileName: 'renamed(6).csv', players: [...a.players].reverse() }
    expect(gcFingerprint(a)).toBe(gcFingerprint(b))
    b.players = b.players.map(p => ({ ...p, sourceValues: { ...p.sourceValues, ERA: Number(p.sourceValues.ERA).toString() } }))
    expect(gcFingerprint(a)).toBe(gcFingerprint(b))
  })
  it('rejects missing columns, bad row widths, duplicate identities, invalid counts and innings', () => {
    expect(() => parseGameChanger(csv.replace('#P', 'missing'))).toThrow('Missing pitching column')
    expect(() => readCSV('"unterminated')).toThrow('unterminated')
    const rows = readCSV(csv), start = rows[0].indexOf('Pitching')
    const short = structuredClone(rows); short[2].pop()
    expect(() => parseGameChanger(encode(short))).toThrow('expected 200 columns')
    const invalid = structuredClone(rows); invalid[2][start] = '12.3'
    expect(() => parseGameChanger(encode(invalid))).toThrow('IP')
    invalid[2][start] = '12.1'; invalid[2][start + 4] = '-4'
    expect(() => parseGameChanger(encode(invalid))).toThrow('Row 3: invalid #P')
    rows.splice(3, 0, rows[2]); expect(() => parseGameChanger(encode(rows))).toThrow('duplicate player')
  })
  it('keeps unavailable rates null, real zeros zero, and ignores zero-participation rows', () => {
    const rows = readCSV(csv), start = rows[0].indexOf('Pitching')
    const strike = rows[1].slice(start).indexOf('S%') + start
    rows[2][strike] = '-'; rows[3][strike] = '0'
    expect(parseGameChanger(encode(rows)).players.map(p => p.stats.strikePct).slice(0, 2)).toEqual([null, 0])
    const zero = [...rows[2]]; zero[2] = 'Nonpitcher'
    const end = rows[0].indexOf('Fielding')
    for (let i = start; i < end; i++) zero[i] = i === start ? '0.0' : '0'
    rows.splice(2, 0, zero)
    expect(parseGameChanger(encode(rows)).players).toHaveLength(4)
  })
  it('never matches jersey alone, and requires disambiguation of repeated names', () => {
    const row = parsed().players[0], p = { id: 'p', name: 'Someone Else', jersey: row.jersey } as Pitcher
    const memberships = [{ teamId: 'team', pitcherId: 'p', active: true }]
    expect(suggestGCMatch(row, 'team', 'fall', [p], memberships, []).pitcherId).toBe('')
    p.name = row.name
    expect(suggestGCMatch(row, 'team', 'fall', [p], memberships, [])).toEqual({ pitcherId: 'p', remembered: false })
    expect(suggestGCMatch(row, 'team', 'Fall', [p], memberships, [{ teamId: 'team', season: 'fall', sourceKey: row.sourceKey, pitcherId: 'p' }]).remembered).toBe(true)
    expect(suggestGCMatch(row, 'team', 'fall', [p, { ...p, id: 'p2' }], [...memberships, { ...memberships[0], pitcherId: 'p2' }], []).pitcherId).toBe('')
  })
})

describe('GC comparison', () => {
  const appearances: Appearance[] = [{ id: 'a', sessionId: 's', pitcherId: 'p', order: 0, balls: 1, strikes: 0, pitches: ['called', 'ball', 'inPlay'], outcome: 'inPlay' }]
  it('weights estimated rates by their own denominators and sums compatible counts', () => {
    const p = players()[0]; p.stats = { ...p.stats, pitches: 100, batters: 20, walks: 2, strikeouts: 5, strikePct: 50, firstPitchPct: 40 }
    const c = gcComparison(appearances, [p])
    expect(c.combined).toMatchObject({ total: 103, batters: 21, walks: 2, strikeouts: 5 })
    expect(c.combined.strikePct).toBeCloseTo(52 / 103 * 100)
    expect(c.combined.firstPitchPct).toBeCloseTo(9 / 21 * 100)
    expect(c.combined.walkPct).toBeCloseTo(2 / 21 * 100)
    expect(c.combined.pitchesPerBatter).toBeCloseTo(103 / 21)
    p.stats.strikePct = null
    expect(gcComparison(appearances, [p]).combined.strikePct).toBeNull()
    p.stats.pitches = 0
    expect(gcComparison(appearances, [p]).combined.strikePct).toBeCloseTo(2 / 3 * 100)
    expect(gcComparison([], []).game.strikePct).toBeNull()
  })
  it('excludes partial date ranges instead of prorating', () => {
    expect(gcCovered(summary(), { start: '2026-09-01', end: '2026-10-20' })).toBe(true)
    expect(gcCovered(summary(), { start: '2026-10-01', end: '2026-10-20' })).toBe(false)
    expect(gcCovered(summary(), { start: '2026-09-01', end: '2026-10-19' })).toBe(false)
    expect(gcCovered(summary(), null)).toBe(true)
  })
})

describe('GC persistence and backups', () => {
  it('round trips summaries/mappings offline without creating pitch events; validates references and legacy backups', async () => {
    const db = new PitchDatabase(`gc-backup-${crypto.randomUUID()}`), target = new PitchDatabase(`gc-backup-target-${crypto.randomUUID()}`)
    try {
      const repo = new Repository(db), s = summary(), stamp = s.updatedAt
      await db.teams.put({ id: 'team', name: 'Samples', createdAt: stamp, updatedAt: stamp, archived: false })
      await db.pitchers.bulkPut(s.players.map(p => ({ id: p.pitcherId, name: p.name, jersey: p.jersey, archived: false, ownerId: 'coach', createdAt: stamp, updatedAt: stamp })))
      await db.gcSummaries.put(s)
      await db.gcMappings.bulkPut(s.players.map(p => ({ teamId: s.teamId, season: s.season, sourceKey: p.sourceKey, pitcherId: p.pitcherId })))
      const backup = await repo.exportBackup()
      expect(backup.version).toBe(4)
      expect(backup.events).toEqual([])
      await new Repository(target).restoreBackup(JSON.parse(JSON.stringify(backup)))
      expect((await new Repository(target).snapshot()).gcSummaries).toEqual([s])
      expect(validateBackup({ ...backup, version: 3 }).gcSummaries).toEqual([])
      const invalid = structuredClone(backup); invalid.gcSummaries[0].players[0].pitcherId = 'missing'
      expect(() => validateBackup(invalid)).toThrow('missing team or pitcher')
      invalid.gcSummaries[0].players[0].stats.pitches = -1
      expect(() => validateBackup(invalid)).toThrow('Invalid GameChanger')
    } finally { await db.delete(); await target.delete() }
  })
})
