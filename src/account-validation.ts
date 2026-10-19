export const requestConfirmation = 'Request received. An admin will review access. Try Google sign-in after approval.'
export function requiredText(value: unknown,max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('Complete all fields using the allowed lengths.')
  return value.trim()
}
export function accountEmail(value: unknown) {
  const email = requiredText(value,254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid Google account email.')
  return email
}
export function accountRequest(value: Record<string,unknown>) {
  return { name:requiredText(value.name,100),email:accountEmail(value.email),requestedTeam:requiredText(value.requestedTeam,200) }
}
