/** Index once when many sessions need their rows; avoid rescanning all history. */
export function bySession<T extends {sessionId:string}>(rows: readonly T[]): Map<string,T[]> {
  const result=new Map<string,T[]>()
  for(const row of rows) {
    let group=result.get(row.sessionId)
    if(!group) {group=[];result.set(row.sessionId,group)}
    group.push(row)
  }
  return result
}
