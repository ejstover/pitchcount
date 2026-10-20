export const requestConfirmation = 'Request received. An admin will review access and provide a private password setup link after approval.'
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
  return { name:requiredText(value.name,100),email:accountEmail(value.email),requestedTeam:requiredText(value.requestedTeam,200) }
}
