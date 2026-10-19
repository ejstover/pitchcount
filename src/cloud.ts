import type { SupabaseClient } from '@supabase/supabase-js'
import { CloudError, type Gateway, type Snapshot, type Upload } from './shared'
import { createId } from './id'

export function getDeviceId(): string {
  const key = 'pitchwork-device-id'
  let value = localStorage.getItem(key)
  if (!value) { value = createId(); localStorage.setItem(key, value) }
  return value
}
export class SupabaseGateway implements Gateway {
  constructor(private client: SupabaseClient) {}
  private async rpc<T>(name: string, input?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(name, input)
    if (error) throw new CloudError(error.message, error.code)
    return data as T
  }
  workspace() { return this.rpc<Omit<Snapshot, 'appearances'>>('get_workspace') }
  manage(action: string, input: Record<string, unknown>) { return this.rpc('manage', { action, input }) }
  upload(operation: Upload) { return this.rpc<number>('upload_practice', { operation }) }
}
