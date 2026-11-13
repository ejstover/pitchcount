export const requestConfirmation = 'Request received. Check your email for a verification code. After verification, an admin will review your account.'
export function requiredText(value: unknown,max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('Complete all fields using the allowed lengths.')
  return value.trim()
}
export function accountEmail(value: unknown) {
  const email = requiredText(value,254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.')
  return email
}
export function validatePassword(password:string) {
  if (password.length < 15) throw new Error('Use at least 15 characters. A few unrelated words make a good passphrase.')
  if (new TextEncoder().encode(password).length > 72) throw new Error('Use a password of at most 72 UTF-8 bytes (fewer characters when using emoji or accented letters).')
}
export function accountRequest(value: Record<string,unknown>) {
  const role = value.role ?? 'coach'
  if (role !== 'coach' && role !== 'player') throw new Error('Choose Player or Coach.')
  const requestedTeam = role === 'coach' ? requiredText(value.requestedTeam,200) : optionalText(value.requestedTeam,200)
  return { name:requiredText(value.name,100),email:accountEmail(value.email),role,requestedTeam,
    username:role === 'player' ? playerUsername(value.username) : null }
}
function optionalText(value:unknown,max:number) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || value.trim().length > max) throw new Error('Use a team name of at most 200 characters.')
  return value.trim()
}
export function playerUsername(value:unknown) {
  const username = requiredText(value,24).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(username)) throw new Error('Use 3–24 letters, numbers, dots, underscores or hyphens for your username.')
  return username
}
