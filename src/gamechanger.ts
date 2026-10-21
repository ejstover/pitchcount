import { metrics, type Appearance, type Pitcher, type TeamPitcher } from './domain'
import type { DateRange } from './statistics'
import { validCustomRange } from './statistics'

export const gcFields = { '#P': 'pitches', BF: 'batters', BB: 'walks', SO: 'strikeouts', GP: 'games', IP: 'outs', H: 'hits', R: 'runs', ER: 'earnedRuns', HBP: 'hitBatters', WP: 'wildPitches', 'S%': 'strikePct', 'FPS%': 'firstPitchPct', ERA: 'era', WHIP: 'whip' } as const
export type GCStats = Record<typeof gcFields[keyof typeof gcFields], number | null>
export interface GCRow { sourceKey: string; name: string; jersey: string; stats: GCStats; sourceValues: Record<string, string> }
export interface GCPlayer extends GCRow { pitcherId: string }
export interface GCSummary {
  id: string; teamId: string; season: string; coverageStart: string; coverageEnd: string
  fileName: string; players: GCPlayer[]; teamTotals: GCStats | null; warnings: string[]
  revision: number; importedBy: string | null; importedByName: string; updatedAt: string; fingerprint: string
}
export interface GCMapping { teamId: string; season: string; sourceKey: string; pitcherId: string }
export interface GCImport {
  teamId: string; season: string; coverageStart: string; coverageEnd: string; fileName: string
  players: GCPlayer[]; teamTotals: GCStats | null; warnings: string[]
  newPitchers: { id: string; name: string; jersey: string }[]
  operationId: string; expectedRevision: number; coverageConfirmed: boolean
  expectedSummaryId?: string | null
}
export const normalizeGCName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
export const gcSeasonKey = (season: string) => normalizeGCName(season)

/** RFC-style quoted fields, including escaped quotes and embedded line breaks. */
export function readCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closed = true } }
      else field += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false
      if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; rows.push(row); row = [] }
    } else if (c === '"' && field === '' && !closed) quoted = true
    else { if (closed || c === '"') throw new Error(`Invalid CSV near row ${rows.length + 1}.`); field += c }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field.')
  if (row.length || field || closed) { row.push(field); rows.push(row) }
  return rows
}
const missing = (v: string) => ['', '-', 'N/A'].includes(v.trim().toUpperCase())
export function parseGCStats(values: Record<string, string>, label: string): GCStats {
  const result = {} as GCStats
  for (const [header, key] of Object.entries(gcFields)) {
    const raw = (values[header] ?? '').trim()
    if (missing(raw)) { result[key as keyof GCStats] = null; continue }
    if (key === 'outs') {
      if (!/^\d+\.[012]$/.test(raw)) throw new Error(`${label}: IP must use innings and outs, such as 12.1.`)
      const [innings, outs] = raw.split('.').map(Number)
      result.outs = innings * 3 + outs
    } else {
      const number = Number(raw)
      const rate = ['strikePct', 'firstPitchPct', 'era', 'whip'].includes(key)
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(number) || number < 0 || (!rate && !Number.isSafeInteger(number)) || (header.endsWith('%') && number > 100)) throw new Error(`${label}: invalid ${header} value “${raw}”.`)
      result[key as keyof GCStats] = number
    }
  }
  if (result.outs !== null && !Number.isSafeInteger(result.outs)) throw new Error(`${label}: IP is too large.`)
  return result
}
export function parseGameChanger(text: string) {
  const rows = readCSV(text)
  const sectionIndex = rows.findIndex(row => row.includes('Pitching'))
  if (sectionIndex < 0 || !rows[sectionIndex + 1]) throw new Error('Choose a GameChanger standard stats CSV with a Pitching section.')
  const sections = rows[sectionIndex], headers = rows[sectionIndex + 1]
  const start = sections.indexOf('Pitching')
  const end = sections.findIndex((value, index) => index > start && !!value.trim())
  const pitchingHeaders = headers.slice(start, end < 0 ? headers.length : end)
  for (const column of ['#P', 'BF', 'BB', 'SO', 'GP', 'IP']) if (!pitchingHeaders.includes(column)) throw new Error(`Missing pitching column: ${column}.`)
  if (new Set(pitchingHeaders).size !== pitchingHeaders.length) throw new Error('Duplicate columns within the Pitching section.')
  const first = headers.indexOf('First'), last = headers.indexOf('Last'), number = headers.indexOf('Number')
  if (first < 0 || last < 0 || number < 0) throw new Error('Missing player identity columns (Number, Last, First).')
  const players: GCRow[] = []; let teamTotals: GCStats | null = null
  for (let index = sectionIndex + 2; index < rows.length; index++) {
    const row = rows[index]
    if (row.every(value => !value.trim()) || row[0]?.trim() === 'Glossary') continue
    if (row.length !== headers.length) throw new Error(`Row ${index + 1}: expected ${headers.length} columns, found ${row.length}.`)
    const sourceValues = Object.fromEntries(pitchingHeaders.map((header, i) => [header, row[start + i].trim()]))
    const stats = parseGCStats(sourceValues, `Row ${index + 1}`)
    if (row[0].trim() === 'Totals') { if (teamTotals) throw new Error('Multiple team Totals rows.'); teamTotals = stats; continue }
    if (![stats.pitches, stats.batters, stats.games, stats.outs].some(value => value !== null && value > 0)) continue
    const name = `${row[first].trim()} ${row[last].trim()}`.trim(), jersey = row[number].trim()
    if (!name) throw new Error(`Row ${index + 1}: player name is missing.`)
    if (['pitches', 'batters', 'walks', 'strikeouts'].some(key => stats[key as keyof GCStats] === null)) throw new Error(`Row ${index + 1}: pitching counts #P, BF, BB, and SO are required for participating pitchers.`)
    const sourceKey = `${normalizeGCName(name)}|${jersey}`
    if (players.some(p => p.sourceKey === sourceKey)) throw new Error(`Row ${index + 1}: duplicate player identity ${name}.`)
    players.push({ sourceKey, name, jersey, stats, sourceValues })
  }
  if (!players.length) throw new Error('No participating pitchers found in this export.')
  const warnings: string[] = []
  for (const key of ['pitches', 'batters', 'walks', 'strikeouts'] as const) {
    const sum = players.reduce((total, p) => total + (p.stats[key] ?? 0), 0)
    if (teamTotals?.[key] !== null && teamTotals?.[key] !== undefined && sum !== teamTotals[key]) warnings.push(`Pitcher ${key} total ${sum}; GC team total ${teamTotals[key]}. Pitcher comparisons use player rows.`)
  }
  return { players: players.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)), teamTotals, warnings }
}
export function suggestSeason(fileName: string) { return fileName.replace(/\s*Stats(?:\(\d+\))?\.csv$/i, '').trim() }
export function suggestGCMatch(row: GCRow, teamId: string, season: string, pitchers: Pitcher[], memberships: TeamPitcher[], mappings: GCMapping[]) {
  const candidates = pitchers.filter(p => memberships.some(m => m.teamId === teamId && m.pitcherId === p.id))
  const remembered = mappings.find(m => m.teamId === teamId && gcSeasonKey(m.season) === gcSeasonKey(season) && m.sourceKey === row.sourceKey)
  if (remembered && candidates.some(p => p.id === remembered.pitcherId)) return { pitcherId: remembered.pitcherId, remembered: true }
  const names = candidates.filter(p => normalizeGCName(p.name) === normalizeGCName(row.name))
  const jerseys = names.filter(p => p.jersey === row.jersey)
  return { pitcherId: (names.length === 1 ? names[0] : jerseys.length === 1 ? jerseys[0] : undefined)?.id ?? '', remembered: false }
}
/** Canonical semantic fingerprint; excludes file name, import metadata, row order and source formatting. */
export function gcFingerprint(value: Pick<GCImport, 'players' | 'teamTotals' | 'coverageStart' | 'coverageEnd'>): string {
  const stable = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`
  const normalize = (v: string) => missing(v) ? null : /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v) ? Number(v) : v
  return stable({ coverageStart: value.coverageStart, coverageEnd: value.coverageEnd, teamTotals: value.teamTotals, players: value.players.map(p => ({ ...p, name: normalizeGCName(p.name), sourceValues: Object.fromEntries(Object.entries(p.sourceValues).map(([k, v]) => [k, normalize(v)])) })).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)) })
}
export function gcCovered(summary: GCSummary, range: DateRange | null) { return !range || range.start <= summary.coverageStart && range.end >= summary.coverageEnd }
export function validateGCSummary(value: unknown): GCSummary {
  const fail = (): never => { throw new Error('Invalid GameChanger summary in backup.') }
  if (!value || typeof value !== 'object') return fail()
  const s = value as GCSummary
  if (!['id', 'teamId', 'season', 'coverageStart', 'coverageEnd', 'fileName', 'importedByName', 'updatedAt', 'fingerprint'].every(k => typeof s[k as keyof GCSummary] === 'string')) return fail()
  if (!s.id || !s.teamId || !s.season.trim() || !validCustomRange(s.coverageStart, s.coverageEnd) || !Number.isFinite(Date.parse(s.updatedAt)) || !Number.isSafeInteger(s.revision) || s.revision < 1 || !(s.importedBy === null || typeof s.importedBy === 'string')) return fail()
  const statsValid = (stats: GCStats) => stats && Object.values(gcFields).every(key => stats[key] === null || typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key]! >= 0 && (['strikePct', 'firstPitchPct', 'era', 'whip'].includes(key) || Number.isSafeInteger(stats[key])) && (!['strikePct', 'firstPitchPct'].includes(key) || stats[key]! <= 100))
  if (!Array.isArray(s.players) || !s.players.length || !Array.isArray(s.warnings) || !s.warnings.every(w => typeof w === 'string') || !(s.teamTotals === null || statsValid(s.teamTotals))) return fail()
  for (const p of s.players) if (!p || !['sourceKey', 'name', 'jersey', 'pitcherId'].every(k => typeof p[k as keyof GCPlayer] === 'string') || !p.pitcherId || !p.name.trim() || p.sourceKey !== `${normalizeGCName(p.name)}|${p.jersey}` || !statsValid(p.stats) || ['pitches', 'batters', 'walks', 'strikeouts'].some(k => p.stats[k as keyof GCStats] === null) || !p.sourceValues || typeof p.sourceValues !== 'object' || Array.isArray(p.sourceValues) || !Object.values(p.sourceValues).every(v => typeof v === 'string')) return fail()
  if (new Set(s.players.map(p => p.sourceKey)).size !== s.players.length || new Set(s.players.map(p => p.pitcherId)).size !== s.players.length) return fail()
  return s
}
export function gcComparison(appearances: Appearance[], players: GCPlayer[]) {
  const practice = metrics(appearances)
  const sum = (key: keyof GCStats) => players.length && players.every(p => p.stats[key] !== null) ? players.reduce((n, p) => n + p.stats[key]!, 0) : null
  const total = sum('pitches'), batters = sum('batters'), walks = sum('walks'), strikeouts = sum('strikeouts')
  const rate = (key: 'strikePct' | 'firstPitchPct', weight: 'pitches' | 'batters') => {
    const denominator = sum(weight)
    if (!denominator || players.some(p => p.stats[weight]! > 0 && p.stats[key] === null)) return null
    return players.reduce((n, p) => n + (p.stats[key] ?? 0) * p.stats[weight]!, 0) / denominator
  }
  const game = { total, batters, walks, strikeouts, strikePct: rate('strikePct', 'pitches'), firstPitchPct: rate('firstPitchPct', 'batters'), walkPct: batters && walks !== null ? walks / batters * 100 : null, pitchesPerBatter: batters && total !== null ? total / batters : null }
  const add = (a: number, b: number | null) => b === null ? null : a + b
  const combinedTotal = add(practice.total, total), combinedBatters = add(practice.batters, batters), combinedWalks = add(practice.walks, walks)
  const blend = (practiceNumerator: number, gameRate: number | null, gameWeight: number | null, denominator: number | null) => !denominator || gameWeight === null || (gameWeight > 0 && gameRate === null) ? null : (practiceNumerator + (gameRate ?? 0) / 100 * gameWeight) / denominator * 100
  const combined = { total: combinedTotal, batters: combinedBatters, walks: combinedWalks, strikeouts: add(practice.strikeouts, strikeouts), strikePct: blend(practice.positive, game.strikePct, total, combinedTotal), firstPitchPct: blend((practice.firstPitchPct ?? 0) / 100 * practice.batters, game.firstPitchPct, batters, combinedBatters), walkPct: combinedBatters && combinedWalks !== null ? combinedWalks / combinedBatters * 100 : null, pitchesPerBatter: combinedBatters && combinedTotal !== null ? combinedTotal / combinedBatters : null }
  return { practice, game, combined }
}
