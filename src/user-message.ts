/** Translate service and browser failures at the UI boundary; keep raw errors for retries. */
export function userMessage(value: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const message = typeof value === 'string' ? value : value instanceof Error ? value.message : ''
  if (!message.trim()) return fallback
  if (/Player sign-in is not configured/i.test(message)) return 'Player sign-in is temporarily unavailable. Please try again later or contact your admin.'
  if (/Account requests are not configured/i.test(message)) return 'Account requests are temporarily unavailable. Please try again later or contact your admin.'
  if (/Account creation failed.*auth hook/i.test(message)) return 'This account could not be created. Please try again later.'
  if (/Invalid backup|Unsupported backup|Duplicate backup|Orphan backup|Missing backup|in backup/i.test(message)) return 'This backup could not be restored. Choose an original Pitchwork backup file or download a new backup from the device with your records.'
  if (/Activity changed\./i.test(message)) return 'This activity changed on another device. Export unsynced work in Settings before loading the synced activity.'
  if (/Recorded events cannot change/i.test(message)) return 'This practice could not sync because its saved history differs. Export unsynced work in Settings to keep a recovery copy.'
  if (/Practice revision conflict|Invalid (?:event|revision|boundary|participants|practice field)|Events cannot be deleted|Practice identity cannot change|Practice status disagrees with events/i.test(message)) return 'This practice could not sync because its saved history differs. Export unsynced work in Settings to keep a recovery copy.'
  if (/Operation (?:ID|identifier) already used|Missing (?:import operation ID|expected revision)|revision conflict/i.test(message)) return 'This change could not be saved. Refresh & sync, review the latest information, and try again.'
  if (/authentication cleanup|auth cleanup/i.test(message)) return 'Sign-in access has been removed. Choose Finish account deletion to complete the deletion.'
  if (/Linked player access required|A linked player account is required/i.test(message)) return 'Ask your coach or admin to connect your account to your pitcher profile.'
  if (/Achievement timezone is fixed/i.test(message)) return 'Your award time zone stays the same so past awards keep their original dates.'
  if (/Each source player must map to a different pitcher/i.test(message)) return 'Match each imported player to a different pitcher on your roster.'
  if (/duplicate player identity/i.test(message)) return message.replace('duplicate player identity', 'player appears more than once:')
  if (/Only the player owner or admin can recover this account/i.test(message)) return 'Only the coach who added this pitcher or an admin can reset this player’s password.'
  if (/unterminated quoted field/i.test(message)) return 'This GameChanger file could not be read. Export a fresh standard stats CSV from GameChanger and try again.'
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|timed?\s*out|AbortError|TimeoutError/i.test(message)) return 'Could not connect. Check your connection and try again. Your saved work stays on this device.'
  if (/QuotaExceededError|quota.*exceeded|storage.*full/i.test(message)) return 'This device is running low on storage. Download a backup in Settings before freeing up space, then try again.'
  if (/IndexedDB|DatabaseClosedError|UnknownError|Internal error opening backing store/i.test(message)) return 'Your saved records could not be opened on this device. Try reopening Pitchwork. Keep any backup files for recovery.'
  if (/supabase|postgres|schema|\bSQL\b|\bRPC\b|\bJWT\b|\bPGRST\w*|\bVITE_\w*|edge function|functions? (?:fetch|http|relay) error|non-2xx|failed to send a request|invalid input syntax|violates .*constraint|duplicate key|permission denied for|row.level security|relation .* does not exist|column .* does not exist|could not find .*function|cannot coerce|cannot read properties|is not a function|unknown action|method not allowed|origin not allowed|invalid identifier|\b(?:payload|uuid|jsonb|stack trace)\b|\b(?:operation|record|device|event|appearance) (?:ID|identifier)\b/i.test(message)) return 'Pitchwork could not complete this request. Please try again. If it keeps happening, contact your admin.'
  return message
}
