export function canApplyUpdate(active: boolean, pending: number, dirty: boolean, error: boolean, modal: boolean): boolean {
  return !active && pending === 0 && !dirty && !error && !modal
}
