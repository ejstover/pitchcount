import { describe, expect, it } from 'vitest'
import { CloudError } from './shared'
import { userMessage } from './user-message'

describe('user-facing failures', () => {
  it.each([
    'Could not find the function public.manage in the schema cache',
    'Invalid JWT',
    'FunctionsHttpError: Edge Function returned a non-2xx status code',
    'invalid input syntax for type uuid: "bad-id"',
    'new row violates row-level security policy for table "coaches"',
    'duplicate key value violates unique constraint "players_pkey"',
  ])('keeps service diagnostics out of the user notice: %s', diagnostic => {
    const result = userMessage(new Error(diagnostic))
    expect(result).toContain('contact your admin')
    expect(result).not.toContain(diagnostic)
  })

  it('preserves an actionable coaching instruction', () => {
    const instruction = 'End this practice before archiving the team.'
    expect(userMessage(new Error(instruction))).toBe(instruction)
    expect(userMessage('Goal changed. Refresh and review again.')).toContain('Refresh')
  })

  it('offers recovery guidance for invalid backups without exposing their fields', () => {
    expect(userMessage('Invalid backup: session event sequences must be unique and consecutive.')).toContain('Choose an original Pitchwork backup')
    expect(userMessage('Missing backup goal reference')).not.toContain('reference')
  })

  it('explains saved activity conflicts from earlier app versions', () => {
    expect(userMessage('Activity changed. Export your pending work and review the server version.')).toContain('loading the synced activity')
  })

  it('leaves the original upload rejection intact for the retry policy', () => {
    const error = new CloudError('Recorded events cannot change', 'P0001')
    expect(userMessage(error)).toContain('Export unsynced work')
    expect(error.message).toBe('Recorded events cannot change')
    expect(error.code).toBe('P0001')
  })

  it('gives device and connection failures a next step', () => {
    expect(userMessage(new Error('Failed to fetch'))).toContain('Check your connection')
    expect(userMessage(new Error('QuotaExceededError'))).toContain('Download a backup')
    expect(userMessage(new Error('DatabaseClosedError'))).toContain('Try reopening Pitchwork')
    expect(userMessage(undefined, 'Could not save your notes.')).toBe('Could not save your notes.')
  })
})
