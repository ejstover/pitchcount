import { useEffect, useId, useState } from 'react'
import { datePresets, dateRangeLabel, validCustomRange, type DateRange, type DateSelection } from './statistics'
import './statistics.css'

export function StatisticsDateFilter({ value, range, onChange }: { value: DateSelection; range: DateRange | null; onChange: (selection: DateSelection) => void }) {
  const [editing, setEditing] = useState(value.preset === 'custom')
  const [start, setStart] = useState(value.preset === 'custom' ? value.start : '')
  const [end, setEnd] = useState(value.preset === 'custom' ? value.end : '')
  const [error, setError] = useState('')
  const errorId = useId()
  const selectedStart = value.preset === 'custom' ? value.start : ''
  const selectedEnd = value.preset === 'custom' ? value.end : ''
  useEffect(() => {
    setEditing(value.preset === 'custom'); setStart(selectedStart); setEnd(selectedEnd); setError('')
  }, [value.preset, selectedStart, selectedEnd])
  return <div className="statistics-dates">
    <div className="statistics-date-controls"><label>Date range<select aria-label="Date range" value={editing ? 'custom' : value.preset} onChange={event => {
      const preset = event.target.value as DateSelection['preset']
      setEditing(preset === 'custom'); setError('')
      if (preset !== 'custom') onChange({ preset })
    }}>{Object.entries(datePresets).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {editing && <form className="custom-date-range" noValidate onSubmit={event => {
        event.preventDefault()
        if (!validCustomRange(start, end)) { setError('Choose both dates, with the start on or before the end.'); return }
        setError(''); onChange({ preset: 'custom', start, end })
      }}><label>Start date<input type="date" required value={start} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} onChange={event => setStart(event.target.value)} /></label><label>End date<input type="date" required value={end} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} onChange={event => setEnd(event.target.value)} /></label><button type="submit">Apply</button></form>}
    </div>
    {error && <p id={errorId} role="alert" className="date-range-error">{error}</p>}
    <p className="statistics-date-summary" aria-live="polite"><strong>{dateRangeLabel(range)}</strong> · Based on practice start dates, in your local time.</p>
  </div>
}
