import './teams.css'
import { createId } from './id'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { metrics, percent, pitchLabels, pitchLocations, pitchLocationLabels, project, type Appearance, type Metrics, type Pitcher, type PitchLocation, type PitchType, type Session } from './domain'
import { type Repository, type Snapshot } from './storage'
import { emptySnapshot, teamHasPitcher, type SavePitcher } from './shared'
import { Teams } from './Teams'
import { AccountAdmin } from './AccountAdmin'
import type { Coach, Team, TeamPitcher } from './domain'
import { Settings } from './Settings'
import { usePwa } from './pwa'
import { canApplyUpdate } from './update-policy'

type Page = 'Practice' | 'Teams' | 'Pitchers' | 'Statistics' | 'Sessions' | 'Settings'
type Job = { work: () => Promise<unknown>; done?: () => void; committed?: boolean }
type SaveFailure = { message: string; retry: () => void; discard: () => void }
const empty: Snapshot = emptySnapshot()
// Keep invitation navigation across sign-in and password setup.
const invitationRequest = new URLSearchParams(window.location.search).get('invite')
if (invitationRequest) sessionStorage.setItem('pitchwork-invitation', invitationRequest)
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const time = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    Practice: <><path d="m12 3 9 7-3 11H6L3 10Z" /><path d="M9 13h6M12 10v6" /></>,
    Pitchers: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v2" /></>,
    Statistics: <><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></>,
    Sessions: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 2v6M17 2v6M3 11h18M7 15h3M14 15h3" /></>,
    Settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" /><circle cx="15" cy="17" r="3" fill="currentColor" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    undo: <><path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    pause: <path d="M8 4v16M16 4v16" />,
    play: <path d="m7 4 14 8-14 8Z" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    edit: <><path d="m15 4 5 5-11 11H4v-5ZM13 6l5 5" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.arrow}</svg>
}

/** Stop at the first failed operation; Retry preserves the order of rapid taps. */
function useWorkspace(repository: Repository) {
  const [data, setData] = useState<Snapshot>(empty)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(0)
  const [syncStatus, setSyncStatus] = useState('Checking sync…')
  const [syncError, setSyncError] = useState('')
  const [error, setError] = useState('')
  const jobs = useRef<Job[]>([])
  const running = useRef(false)
  const mounted = useRef(true)
  async function drain() {
    if (running.current) return
    running.current = true
    setError('')
    while (jobs.current.length) {
      const job = jobs.current[0]
      try {
        if (!job.committed) { await job.work(); job.committed = true }
        const next = await repository.snapshot()
        if (!mounted.current) break
        setData(next); setReady(true)
        jobs.current.shift(); setPending(jobs.current.length)
        job.done?.()
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Local storage is unavailable. Try again.')
        break
      }
    }
    running.current = false
  }
  function run(work: Job['work'], done?: Job['done']) {
    jobs.current.push({ work, done }); setPending(jobs.current.length)
    if (!error) void drain()
  }
  useEffect(() => {
    mounted.current = true
    run(async () => undefined)
    return () => { mounted.current = false }
    // Initial load only. Storage transactions, rather than effects, perform mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (dirty = false) => {
      const [next, uploads] = await Promise.all([repository.snapshot(), repository.pendingUploads()])
      if (!alive) return
      setData(next)
      setSyncStatus(uploads.some(o => o.blocked) ? 'Sync needs attention' : uploads.length ? 'Waiting to sync' : 'Synced')
      setSyncError(repository.syncMessage)
      if (dirty) { clearTimeout(timer); timer = setTimeout(() => void repository.sync(), 300) }
    }
    const sync = () => { if (navigator.onLine) void repository.sync() }
    const unsubscribe = repository.subscribe(dirty => { void refresh(dirty) })
    window.addEventListener('online', sync); window.addEventListener('focus', sync)
    void refresh(); sync()
    return () => { alive = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('online', sync); window.removeEventListener('focus', sync) }
  }, [repository])
  function discard() {
    jobs.current = []; setPending(0); setError('')
    run(async () => undefined)
  }
  return { data, ready, pending, error, syncStatus, syncError, run, retry: () => void drain(), discard }
}

function FailureBanner({ failure }: { failure: SaveFailure }) {
  return <div className="error-banner" role="alert"><div><strong>Couldn’t save your changes.</strong><p>{failure.message} Pending actions are held in order.</p></div><button onClick={failure.retry}>Retry</button><button className="text-button" onClick={failure.discard}>Discard unsaved actions</button></div>
}
function Modal({ title, children, close, failure }: { title: string; children: ReactNode; close: () => void; failure?: SaveFailure }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLElement>('input, select, textarea')?.focus()
    return () => dialog.current?.close()
  }, [])
  return <dialog ref={dialog} className="modal" onCancel={e => { e.preventDefault(); close() }} aria-labelledby="dialog-title">
    <div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></div>
    {failure && <FailureBanner failure={failure} />}
    {children}
  </dialog>
}

function MetricGrid({ value, compact = false }: { value: Metrics; compact?: boolean }) {
  const items: [string, string | number][] = compact
    ? [['Pitches', value.total], ['Strike %', percent(value.strikePct)], ['Batters faced', value.batters], ['First-pitch strike %', percent(value.firstPitchPct)]]
    : [['Total pitches', value.total], ['Balls', value.balls], ['Positive strike outcomes', value.positive], ['Strike %', percent(value.strikePct)], ['First-pitch strike %', percent(value.firstPitchPct)], ['Batters faced', value.batters], ['Walks', value.walks], ['Strikeouts', value.strikeouts], ['Walk %', percent(value.walkPct)], ['Pitches / batter', value.pitchesPerBatter?.toFixed(1) ?? '—']]
  return <dl className={`metric-grid ${compact ? 'compact' : ''}`}>{items.map(([label, val]) => <div key={label}><dt>{label}</dt><dd>{val}</dd></div>)}</dl>
}
function MetricDefinition() {
  return <details className="definition"><summary>What counts as a strike outcome?</summary><p>Strike % = (called strikes + swinging strikes + all fouls + balls in play) ÷ total pitches × 100. Every two-strike foul counts here, even though it doesn’t advance the batter’s count.</p><p>First-pitch strike % includes every batter with at least one pitch. Walk % and pitches per batter use the same batters-faced denominator. Manually ended batters never become walks or strikeouts.</p></details>
}

function PitchTile({ type, label, disabled, record }: { type: PitchType; label: string; disabled: boolean; record: (type: PitchType, location: PitchLocation) => void }) {
  return <div className={`pitch-tile pitch-${type}`} role="group" aria-label={label}>
    <strong className="pitch-title">{label}</strong>
    <div className="pitch-location-map">{pitchLocations.map(location => <button
      key={location} type="button" className={`pitch-target pitch-location-${location}`}
      aria-label={`${pitchLabels[type]}, ${pitchLocationLabels[location].toLowerCase()}`}
      disabled={disabled} onClick={() => record(type, location)}
    />)}</div>
  </div>
}

export function App({ repository, coach, onSignOut }: { repository: Repository; coach: Coach; onSignOut: () => Promise<void> }) {
  const { data, ready, pending, error, syncStatus, syncError, run, retry, discard } = useWorkspace(repository)
  const canEdit = coach.active && coach.role !== 'viewer'
  const [page, setPage] = useState<Page>(sessionStorage.getItem('pitchwork-invitation') ? 'Teams' : 'Practice')
  const [pitcherForm, setPitcherForm] = useState<Pitcher | 'new' | null>(null)
  const [startOpen, setStartOpen] = useState(false)
  const [switchOpen, setSwitchOpen] = useState(false)
  const [endOpen, setEndOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [teamFilter, setTeamFilter] = useState('')
  const [archiveFilter, setArchiveFilter] = useState('active')
  const [statPitcher, setStatPitcher] = useState('')
  const [statTeam, setStatTeam] = useState('')
  const [scope, setScope] = useState('all')
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [restorePreview, setRestorePreview] = useState(false)
  const pwa = usePwa()
  const failure = error ? { message: error, retry, discard } : undefined
  const modalOpen = !!(pitcherForm || startOpen || switchOpen || endOpen || resetOpen)
  const session = data.sessions.find(s => s.status !== 'ended' && repository.owns(s))
  const dirtyNotes = Object.entries(noteDrafts).some(([id, value]) => data.sessions.some(s => s.id === id && s.notes !== value))
  const updateAllowed = ready && canApplyUpdate(session?.status === 'active', pending, dirtyNotes, !!error, modalOpen || restorePreview)
  function setNote(id: string, value: string) { setNoteDrafts(previous => ({ ...previous, [id]: value })) }
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (pending || error || dirtyNotes) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [pending, error, dirtyNotes])
  const pitcher = data.pitchers.find(p => p.id === session?.selectedPitcherId)
  const activePitchers = data.pitchers.filter(p => !p.archived && (!session?.teamId || teamHasPitcher(data, session.teamId, p.id))).sort((a, b) => a.name.localeCompare(b.name))
  const events = session ? data.events.filter(e => e.sessionId === session.id) : []
  const projection = session ? project(session, events) : null
  const pitcherAppearances = data.appearances.filter(a => a.sessionId === session?.id && a.pitcherId === pitcher?.id)
  const currentStats = metrics(pitcherAppearances)
  const frozen = session?.status !== 'active' || !!error || !canEdit
  const canEditPitcher = (p: Pitcher) => canEdit && (coach.role === 'admin' || p.ownerId === coach.id || data.teamPitchers.some(m => m.pitcherId === p.id && m.active))
  const pitcherTeams = (id: string) => data.teamPitchers.filter(m => m.pitcherId === id && m.active).map(m => data.teams.find(t => t.id === m.teamId)?.name).filter(Boolean).join(' · ') || 'Independent'
  const teamName = (id: string | null) => data.teams.find(t => t.id === id)?.name ?? 'Independent'
  const act = (action: Parameters<typeof repository.act>[1], value?: string, done?: () => void) => {
    if (session) run(() => repository.act(session.id, action, value), done)
  }
  const recordPitch = (type: PitchType, location: PitchLocation) => {
    if (session) run(() => repository.act(session.id, 'pitch', type, location))
  }
  const navigate = (next: Page) => { setPage(next); setDetailsId(null) }
  const allPitcherStats = (id: string) => metrics(data.appearances.filter(a => a.pitcherId === id))
  const selectedSession = data.sessions.find(s => s.id === detailsId)
  const filteredAppearances = data.appearances.filter(a => (!statPitcher || a.pitcherId === statPitcher) && (!statTeam || data.sessions.find(s => s.id === a.sessionId)?.teamId === statTeam) && (scope === 'all' || a.sessionId === session?.id))

  return <div className={`app-shell ${page === 'Practice' && session ? 'is-practicing' : ''}`}>
    <aside className="sidebar">
      <a className="brand" href="#practice" onClick={() => navigate('Practice')}><span className="brand-mark">p<span>·</span></span><span>pitchwork<span className="brand-caption">MAKE EVERY PITCH COUNT</span></span></a>
      <div className="side-label">THE COACH’S DUGOUT</div>
      <nav aria-label="Main navigation">{(['Practice', 'Pitchers', 'Statistics', 'Sessions', 'Settings'] as Page[]).map(item => <button key={item} aria-current={(page === item || (item === 'Pitchers' && page === 'Teams')) ? 'page' : undefined} className={(page === item || (item === 'Pitchers' && page === 'Teams')) ? 'nav-item selected' : 'nav-item'} onClick={() => navigate(item)}><Icon name={item} /><span>{item === 'Pitchers' ? 'Roster' : item}</span>{item === 'Practice' && session && <span className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><span className="local-dot" /> STORED ON THIS DEVICE<p>{coach.name}</p><small>Baseball & softball</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span>FIELD NOTES <span className="topbar-slash">/</span> {page.toUpperCase()}</span><span className="save-status" role="status"><span className={`local-dot ${pending ? 'busy' : ''}`} />{error ? 'Save needs attention' : pending ? `Saving${pending > 1 ? ` ${pending} actions` : ''}…` : ready ? 'Saved on device' : 'Opening local data…'}</span></header>
      {failure && !modalOpen && <FailureBanner failure={failure} />}
      <div className="connection-strip" aria-label="Connection and offline availability"><span>{syncStatus}</span><button className="text-button" onClick={() => void repository.sync()} disabled={!pwa.online}>Refresh & sync</button><span>{pwa.online ? 'Online' : 'Offline'}</span><span>{pwa.offlineReady ? 'Ready offline' : !pwa.production ? 'Offline setup available after publishing' : !pwa.supported ? 'Offline installation needs HTTPS' : 'Preparing offline access…'}</span></div>
      {syncError && <div className="pwa-notice" role="alert">{syncError}</div>}
      {pwa.error && <div className="pwa-notice">{pwa.error}</div>}
      {pwa.updateReady && <div className="pwa-notice update-notice"><div><strong>An app update is ready.</strong><p>{updateAllowed ? 'Your records will be kept when the app reloads.' : 'Pause practice, finish saving, and close any open forms before updating.'}</p></div><button disabled={!updateAllowed} onClick={() => void pwa.update()}>Update app</button></div>}
      {!ready ? <main><div className="empty-card"><h1>Opening your dugout…</h1><p>Loading the roster and practice history saved on this device.</p></div></main> : <main>
        <div className="page-heading"><div><div className="eyebrow">{page === 'Practice' ? 'ONE PITCH AT A TIME' : (page === 'Pitchers' || page === 'Teams') ? 'YOUR PEOPLE, THEIR PROGRESS' : page === 'Statistics' ? 'THE WORK ADDS UP' : page === 'Settings' ? 'READY FOR THE NEXT PRACTICE' : 'A RECORD OF THE REPS'}</div><h1>{page === 'Practice' ? 'Practice' : page === 'Teams' ? 'Your teams' : page === 'Pitchers' ? 'Your roster' : page === 'Statistics' ? 'By the numbers' : page === 'Settings' ? 'Make it yours' : 'Practice history'}<span className="heading-dot">.</span></h1><p>{page === 'Practice' ? 'Eyes on the pitcher. We’ll keep the count.' : page === 'Teams' ? 'Bring your pitchers and coaches together.' : page === 'Pitchers' ? 'Room for every pitcher. A history for each one.' : page === 'Statistics' ? 'A clear view of the pitches put in.' : page === 'Settings' ? 'Take your notebook with you. Keep a copy of your work.' : 'Pick up where you left off, or look back at the work.'}</p></div>
          {page === 'Pitchers' && <button className="primary" onClick={() => setPitcherForm('new')} disabled={!!error || !canEdit}><Icon name="plus" />Add pitcher</button>}
          {page === 'Practice' && session && <div className={`session-badge ${session.status}`}><span className="local-dot" />{session.status === 'paused' ? 'SESSION PAUSED' : 'LIVE PRACTICE'}</div>}
        </div>

        {(page === 'Pitchers' || page === 'Teams') && <div className="roster-tabs" aria-label="Roster sections"><button aria-pressed={page === 'Pitchers'} onClick={() => setPage('Pitchers')}>Pitchers</button><button aria-pressed={page === 'Teams'} onClick={() => setPage('Teams')}>Teams</button></div>}
        {page === 'Teams' && <Teams data={data} repository={repository} coach={coach} disabled={pending > 0 || !!error} run={run} onPractice={id => { setDetailsId(id); setPage('Sessions') }} />}
        {page === 'Practice' && (!session ? <div className="welcome-grid"><section className="welcome-card"><div className="eyebrow">THE BULLPEN IS OPEN</div><h2>Good practices<br />start with a pitch.</h2><p>Choose a pitcher, start a session, and keep your attention where it belongs.</p><button className="primary lime" disabled={!!error || !canEdit} onClick={() => activePitchers.length ? setStartOpen(true) : setPitcherForm('new')}>{activePitchers.length ? 'Start practice' : 'Add your first pitcher'}<Icon name="arrow" /></button><div className="welcome-footer"><span>01 / SHOW UP</span><span>02 / PUT IN THE REPS</span></div><div className="baseball-art" aria-hidden="true"><span /></div></section><section className="card getting-started"><span className="eyebrow">A LITTLE LESS KEEPING SCORE</span><h2>A little more coaching.</h2><div className="step"><b>01</b><div><h3>Build your roster</h3><p>Add pitchers and optional teams. Everyone gets a place.</p></div></div><div className="step"><b>02</b><div><h3>Track with a tap</h3><p>Ball, strike, foul, or in play. We handle the batter count.</p></div></div><div className="step"><b>03</b><div><h3>See the work</h3><p>Review session totals and each pitcher’s history.</p></div></div><p className="local-note"><span className="local-dot" />Saved locally, after every pitch.</p></section></div> : <>
          <div className="session-line"><span><strong>{session.name || 'Bullpen practice'}</strong><span className="dot-separator">·</span>{date(session.startedAt)} <span className="session-time">at {time(session.startedAt)}</span></span><div><button className="text-button" disabled={!!error || !canEdit} onClick={() => act(session.status === 'paused' ? 'resume' : 'pause')}><Icon name={session.status === 'paused' ? 'play' : 'pause'} size={16} />{session.status === 'paused' ? 'Resume' : 'Pause'}</button><button className="text-button" disabled={!!error || !canEdit} onClick={() => setEndOpen(true)}>End session <Icon name="arrow" size={16} /></button></div></div>
          <div className="practice-grid"><section className="tracking-card">
            <div className="pitcher-heading"><div className="avatar">{pitcher?.jersey || pitcher?.name.charAt(0).toUpperCase() || '?'}</div><div><span className="eyebrow">ON THE MOUND</span><h2>{pitcher?.name}</h2><p>{teamName(session.teamId)}{pitcher?.jersey ? ` · #${pitcher.jersey}` : ''}</p></div><button className="switch-button" disabled={frozen} onClick={() => setSwitchOpen(true)}>Change pitcher <Icon name="arrow" size={16} /></button></div>
            <div className="scoreboard" aria-live="polite" aria-atomic="true"><div className="count-block"><span className="score-label">BATTER COUNT</span><div className="count-numbers"><span aria-label={`${projection?.current.balls} balls`}>{projection?.current.balls}<small>BALLS</small></span><span className="count-divider">–</span><span aria-label={`${projection?.current.strikes} strikes`}>{projection?.current.strikes}<small>STRIKES</small></span></div></div><div className="score-side"><div><span className="score-label">PITCH COUNT</span><strong>{currentStats.total}</strong></div><div><span className="score-label">STRIKE %</span><strong>{percent(currentStats.strikePct)}</strong></div></div></div>
            {session.status === 'paused' && <div className="paused-message">Practice paused. Resume when you’re ready to throw.</div>}
            <div className="pitch-grid">{([
              ['ball', 'BALL'], ['called', 'STRIKE'], ['foul', 'FOUL'], ['inPlay', 'IN PLAY'],
            ] as [PitchType, string][]).map(([type, label]) => <PitchTile key={type} type={type} label={label} disabled={frozen} record={recordPitch} />)}</div>
            <div className="swinging-row"><span>Missed the swing?</span><button disabled={frozen} className="text-button" onClick={() => act('pitch', 'swinging')}>Record swinging strike <Icon name="plus" size={16} /></button></div>
            <div className="tracking-actions"><button disabled={frozen || !events.some(e => e.kind === 'pitch' && !e.voidedAt)} onClick={() => act('undo')}><Icon name="undo" size={17} />Undo last pitch</button><button disabled={frozen} onClick={() => act('next')}>Next batter <Icon name="arrow" size={17} /></button><button disabled={frozen} className="reset-button" onClick={() => setResetOpen(true)}>Reset count</button></div>
          </section><aside className="practice-aside"><section className="card session-stats"><div className="section-heading"><h2>This pitcher</h2><span className="small-label">THIS SESSION</span></div><MetricGrid value={currentStats} compact /><div className="mini-stats"><div><strong>{currentStats.walks}</strong><span>Walks</span></div><div><strong>{currentStats.strikeouts}</strong><span>Strikeouts</span></div><div><strong>{currentStats.pitchesPerBatter?.toFixed(1) ?? '—'}</strong><span>Pitches / batter</span></div></div><button className="text-button full-link" onClick={() => { setStatPitcher(pitcher?.id ?? ''); setScope('current'); setPage('Statistics') }}>View all statistics <Icon name="arrow" size={16} /></button></section>
            <section className="card pitch-log"><div className="section-heading"><h2>Recent pitches</h2><span className="small-label">SESSION LOG</span></div>{events.filter(e => e.kind === 'pitch').length === 0 ? <p className="quiet-empty">A fresh count. Tap a pitch outcome to begin.</p> : <ol>{events.filter(e => e.kind === 'pitch').sort((a, b) => b.sequence - a.sequence).slice(0, 6).map(e => <li key={e.id} className={e.voidedAt ? 'voided' : ''}><span className={`log-dot ${e.pitchType}`} /><div><strong>{pitchLabels[e.pitchType!] }{e.voidedAt && ' · undone'}</strong><small>{data.pitchers.find(p => p.id === e.pitcherId)?.name}</small><small>{e.pitchLocation ? pitchLocationLabels[e.pitchLocation] : 'Not recorded'}</small></div><time>{time(e.timestamp)}</time></li>)}</ol>}</section>
          </aside></div><MetricDefinition /><Notes key={session.id} session={session} draft={noteDrafts[session.id]} setDraft={value => setNote(session.id, value)} disabled={!!error || !canEdit} save={notes => run(() => repository.saveNotes(session.id, notes))} />
        </>)}

        {page === 'Pitchers' && <><div className="filter-bar"><label className="search-input"><Icon name="search" /><input type="search" placeholder="Search name or jersey…" aria-label="Search pitchers" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="Filter roster by team" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}><option value="">All teams</option>{data.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><select aria-label="Filter roster by archive status" value={archiveFilter} onChange={e => setArchiveFilter(e.target.value)}><option value="active">Active pitchers</option><option value="archived">Archived pitchers</option><option value="all">All pitchers</option></select></div>
          <div className="roster-grid">{data.pitchers.filter(p => (archiveFilter === 'all' || p.archived === (archiveFilter === 'archived')) && (!teamFilter || teamHasPitcher(data, teamFilter, p.id)) && `${p.name} ${p.jersey}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name)).map(p => { const stats = allPitcherStats(p.id); return <article className="card pitcher-card" key={p.id}><div className="pitcher-card-top"><div className={`avatar ${p.archived ? 'muted-avatar' : ''}`}>{p.jersey || p.name.charAt(0).toUpperCase()}</div><button className="icon-button" aria-label={`Edit ${p.name}`} disabled={!!error || !canEditPitcher(p) || !pwa.online} onClick={() => setPitcherForm(p)}><Icon name="edit" /></button></div><h2>{p.name}</h2><p>{pitcherTeams(p.id)}{p.jersey ? ` · #${p.jersey}` : ''}{p.archived ? ' · Archived' : ''}</p><div className="roster-numbers"><div><strong>{stats.total}</strong><span>Pitches</span></div><div><strong>{percent(stats.strikePct)}</strong><span>Strike %</span></div></div><div className="card-actions"><button className="text-button" onClick={() => { setStatPitcher(p.id); setScope('all'); setStatTeam(''); setPage('Statistics') }}>View history <Icon name="arrow" size={16} /></button><button className="text-button subdued" disabled={!!error || !canEditPitcher(p) || !navigator.onLine || data.teamPitchers.some(m => m.pitcherId === p.id && m.active) || (!p.archived && p.id === session?.selectedPitcherId)} title={data.teamPitchers.some(m => m.pitcherId === p.id && m.active) ? 'Remove team assignments before archiving. Use Teams to remove a pitcher from one roster.' : p.id === session?.selectedPitcherId ? 'Change pitchers or end the session before archiving' : undefined} onClick={() => run(() => repository.manage('archivePitcher', { pitcherId: p.id, archived: !p.archived }))}>{p.archived ? 'Reactivate' : 'Archive'}</button></div></article> })}</div>{!data.pitchers.length && <Empty title="Every pitcher starts somewhere." text="Add your first pitcher to build your roster and start a practice." />}{data.pitchers.length > 0 && !data.pitchers.some(p => (archiveFilter === 'all' || p.archived === (archiveFilter === 'archived')) && (!teamFilter || teamHasPitcher(data, teamFilter, p.id)) && `${p.name} ${p.jersey}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <Empty title="No matching pitchers" text="Try another name, team, or archive filter." />}</>}

        {page === 'Statistics' && <><div className="filter-bar"><select aria-label="Statistics pitcher" value={statPitcher} onChange={e => setStatPitcher(e.target.value)}><option value="">All pitchers</option>{data.pitchers.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>)}</select><select aria-label="Statistics team" value={statTeam} onChange={e => setStatTeam(e.target.value)}><option value="">All teams</option>{data.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><select aria-label="Statistics scope" value={scope} onChange={e => setScope(e.target.value)}><option value="all">All sessions</option><option value="current" disabled={!session}>Current session</option></select></div><section className="card stats-overview"><div className="section-heading"><h2>{statPitcher ? data.pitchers.find(p => p.id === statPitcher)?.name : 'The whole roster'}</h2><span className="small-label">{scope === 'current' ? 'CURRENT SESSION' : 'ALL-TIME TOTALS'}</span></div><MetricGrid value={metrics(filteredAppearances)} /><div className="outcome-breakdown">{(['called', 'swinging', 'fouls', 'inPlay'] as const).map((key, i) => <div key={key}><span>{['Called strikes', 'Swinging strikes', 'Foul balls', 'Balls in play'][i]}</span><strong>{metrics(filteredAppearances)[key]}</strong></div>)}</div></section><MetricDefinition /><h2 className="subheading">Session by session</h2><div className="session-list">{data.sessions.filter(s => filteredAppearances.some(a => a.sessionId === s.id && a.pitches.length)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(s => <SessionRow key={s.id} session={s} team={teamName(s.teamId)} appearances={filteredAppearances.filter(a => a.sessionId === s.id)} onClick={() => { setDetailsId(s.id); setPage('Sessions') }} />)}</div>{!filteredAppearances.some(a => a.pitches.length) && <Empty title="The numbers will follow." text="Record a few pitches in practice to see statistics here." />}</>}

        {page === 'Sessions' && (selectedSession ? <><button className="text-button back-link" onClick={() => setDetailsId(null)}>← All sessions</button><section className="card stats-overview"><div className="section-heading"><div><span className="eyebrow">{date(selectedSession.startedAt)} · {teamName(selectedSession.teamId)} · {time(selectedSession.startedAt)}</span><h2>{selectedSession.name || 'Bullpen practice'}</h2></div><span className={`status-tag ${selectedSession.status}`}>{selectedSession.status}</span></div><MetricGrid value={metrics(data.appearances.filter(a => a.sessionId === selectedSession.id))} />{selectedSession.status !== 'ended' && repository.owns(selectedSession) && <button className="primary" onClick={() => setPage('Practice')}>Return to practice <Icon name="arrow" /></button>}</section><h2 className="subheading">Pitchers in this session</h2>{selectedSession.pitcherIds.map(id => <section key={id} className="card session-pitcher"><h3>{data.pitchers.find(p => p.id === id)?.name}</h3><MetricGrid value={metrics(data.appearances.filter(a => a.sessionId === selectedSession.id && a.pitcherId === id))} compact /></section>)}<Notes key={selectedSession.id} session={selectedSession} draft={noteDrafts[selectedSession.id]} setDraft={value => setNote(selectedSession.id, value)} disabled={!!error || !canEdit || !repository.owns(selectedSession)} save={notes => run(() => repository.saveNotes(selectedSession.id, notes))} /><section className="card history-log"><h2>Pitch history</h2><div className="table-scroll"><table><thead><tr><th>Time</th><th>Pitcher</th><th>Outcome</th><th>Location</th><th>Status</th></tr></thead><tbody>{data.events.filter(e => e.sessionId === selectedSession.id && e.kind === 'pitch').sort((a, b) => a.sequence - b.sequence).map(e => <tr key={e.id}><td>{time(e.timestamp)}</td><td>{data.pitchers.find(p => p.id === e.pitcherId)?.name}</td><td>{pitchLabels[e.pitchType!]}</td><td>{e.pitchLocation ? pitchLocationLabels[e.pitchLocation] : 'Not recorded'}</td><td>{e.voidedAt ? 'Undone' : 'Recorded'}</td></tr>)}</tbody></table></div></section><MetricDefinition /></> : <><div className="list-heading"><span>{data.sessions.length} {data.sessions.length === 1 ? 'session' : 'sessions'} on this device</span><button className="primary" disabled={!!error || !canEdit} onClick={() => session ? setPage('Practice') : activePitchers.length ? setStartOpen(true) : setPitcherForm('new')}>{session ? 'Return to practice' : 'New session'}<Icon name="arrow" /></button></div><div className="session-list">{[...data.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(s => <SessionRow key={s.id} session={s} team={teamName(s.teamId)} appearances={data.appearances.filter(a => a.sessionId === s.id)} onClick={() => setDetailsId(s.id)} />)}</div>{!data.sessions.length && <Empty title="A clean practice notebook." text="Start a session to keep a record of every pitch, pitcher, and practice." />}</>)}
        {page === 'Settings' && <><section className="card account-card"><div><span className="eyebrow">YOUR COACH ACCOUNT</span><h2>{coach.name}</h2><p>{coach.email}</p></div><button disabled={pending > 0 || dirtyNotes || !!session || syncStatus !== 'Synced'} onClick={() => { void onSignOut().catch(cause => window.alert(cause instanceof Error ? cause.message : 'Could not sign out.')) }}>Sign out</button><p className="form-intro">Finish practice, save notes, and sync pending work before signing out.</p></section>{coach.role === 'admin' && <AccountAdmin teams={data.teams} onChanged={() => { void repository.sync() }} />}<Settings repository={repository} canRestore={canEdit} disabled={pending > 0 || !!error} unsavedNotes={dirtyNotes} run={run} onPreview={setRestorePreview} onRestored={() => { setNoteDrafts({}); setDetailsId(null); setStatPitcher(''); setStatTeam(''); setTeamFilter(''); setScope('all') }} offlineReady={pwa.offlineReady} /></>}
        <footer className="page-footer"><span>PITCHWORK / PRACTICE WITH PURPOSE</span><span>Saved on this device · Shared with your teams</span></footer>
      </main>}
    </div>
    {pitcherForm && <Modal failure={failure} title={pitcherForm === 'new' ? 'Add a pitcher' : 'Edit pitcher'} close={() => setPitcherForm(null)}><PitcherForm key={pitcherForm === 'new' ? 'new' : pitcherForm.id} pitcher={pitcherForm === 'new' ? undefined : pitcherForm} teams={data.teams} memberships={data.teamPitchers} disabled={pending > 0 || !!error || !canEdit || !pwa.online} save={input => run(() => repository.savePitcher(input), () => setPitcherForm(null))} /></Modal>}
    {startOpen && <Modal failure={failure} title="Start a practice" close={() => setStartOpen(false)}><StartForm pitchers={data.pitchers.filter(p => !p.archived)} teams={data.teams} memberships={data.teamPitchers} disabled={pending > 0 || !!error || !canEdit} start={(id, name, teamId) => run(() => repository.startSession(id, name, teamId), () => { setStartOpen(false); setPage('Practice') })} /></Modal>}
    {switchOpen && <Modal failure={failure} title="Change pitcher" close={() => setSwitchOpen(false)}><p className="form-intro">The current batter will be manually ended. Your next pitcher starts with a fresh 0–0 count.</p><div className="switch-list">{activePitchers.filter(p => p.id !== pitcher?.id).map(p => <button disabled={pending > 0 || !!error} key={p.id} onClick={() => act('switch', p.id, () => setSwitchOpen(false))}><span className="avatar small">{p.jersey || p.name.charAt(0)}</span><span><strong>{p.name}</strong><small>{pitcherTeams(p.id)}</small></span><Icon name="arrow" /></button>)}</div>{activePitchers.length < 2 && <p>Add another active pitcher from the Pitchers tab to switch.</p>}</Modal>}
    {endOpen && <Modal failure={failure} title="Wrap up practice?" close={() => setEndOpen(false)}><p className="form-intro">All pitches and notes stay in your session history. The unfinished batter will be manually ended, with no added walk or strikeout.</p><div className="form-actions"><button onClick={() => setEndOpen(false)}>Keep practicing</button><button className="primary" disabled={pending > 0 || !!error} onClick={() => act('end', undefined, () => setEndOpen(false))}>End session <Icon name="check" /></button></div></Modal>}
    {resetOpen && <Modal failure={failure} title="Start a fresh count?" close={() => setResetOpen(false)}><p className="form-intro">Recorded pitches stay in the statistics. This batter is marked manually reset, and a new batter starts at 0–0.</p><div className="form-actions"><button onClick={() => setResetOpen(false)}>Keep count</button><button className="primary" disabled={pending > 0 || !!error} onClick={() => act('reset', undefined, () => setResetOpen(false))}>Reset count</button></div></Modal>}
  </div>
}

function Empty({ title, text }: { title: string; text: string }) { return <div className="empty-card"><div className="empty-diamond" aria-hidden="true">◇</div><h2>{title}</h2><p>{text}</p></div> }
function SessionRow({ session, team, appearances, onClick }: { session: Session; team: string; appearances: Appearance[]; onClick: () => void }) {
  const stats = metrics(appearances)
  return <button className="session-row" onClick={onClick}><span className="date-block"><strong>{new Date(session.startedAt).getDate()}</strong><small>{new Date(session.startedAt).toLocaleDateString(undefined, { month: 'short' })}</small></span><span className="session-row-title"><strong>{session.name || 'Bullpen practice'}</strong><small>{team} · {date(session.startedAt)} · {session.pitcherIds.length} {session.pitcherIds.length === 1 ? 'pitcher' : 'pitchers'}</small></span><span className={`status-tag ${session.status}`}>{session.status}</span><span className="row-metric"><strong>{stats.total}</strong><small>Pitches</small></span><span className="row-metric"><strong>{percent(stats.strikePct)}</strong><small>Strike %</small></span><Icon name="arrow" /></button>
}
function PitcherForm({ pitcher, teams, memberships, disabled, save }: { pitcher?: Pitcher; teams: Team[]; memberships: TeamPitcher[]; disabled: boolean; save: (input: SavePitcher) => void }) {
  const [recordId] = useState(() => pitcher?.id ?? createId())
  const [name, setName] = useState(pitcher?.name ?? '')
  const [jersey, setJersey] = useState(pitcher?.jersey ?? '')
  const [teamIds, setTeamIds] = useState(memberships.filter(m => m.pitcherId === pitcher?.id && m.active).map(m => m.teamId))
  return <form onSubmit={e => { e.preventDefault(); save({ id: recordId, name, jersey, teamIds }) }}><label>Pitcher name<input required autoFocus value={name} onChange={e => setName(e.target.value)} autoComplete="off" disabled={disabled} /></label><label>Jersey number <span>optional</span><input value={jersey} onChange={e => setJersey(e.target.value)} inputMode="numeric" disabled={disabled} /></label><fieldset className="team-choices" disabled={disabled}><legend>Teams <span>optional · choose any</span></legend>{teams.map(t => <label key={t.id}><input type="checkbox" checked={teamIds.includes(t.id)} onChange={e => setTeamIds(previous => e.target.checked ? [...previous, t.id] : previous.filter(id => id !== t.id))} /><span>{t.name}</span></label>)}{!teams.length && <p>Create a team from the Teams tab, then assign this pitcher.</p>}</fieldset><button className="primary form-submit" disabled={disabled || !name.trim()} type="submit">{pitcher ? 'Save changes' : 'Add pitcher'}<Icon name="check" /></button></form>
}
function StartForm({ pitchers, teams, memberships, disabled, start }: { pitchers: Pitcher[]; teams: Team[]; memberships: TeamPitcher[]; disabled: boolean; start: (id: string, name: string, teamId: string | null) => void }) {
  const [teamId, setTeamId] = useState('')
  const eligible = pitchers.filter(p => !teamId || memberships.some(m => m.teamId === teamId && m.pitcherId === p.id && m.active))
  const [pitcherId, setPitcherId] = useState(pitchers[0]?.id ?? '')
  const selected = eligible.some(p => p.id === pitcherId) ? pitcherId : eligible[0]?.id ?? ''
  const [name, setName] = useState('')
  return <form onSubmit={(e: FormEvent) => { e.preventDefault(); start(selected, name, teamId || null) }}><label>Practice name <span>optional</span><input autoFocus placeholder="e.g. Sunday bullpen" value={name} onChange={e => setName(e.target.value)} /></label><label>Practice team<select value={teamId} onChange={e => setTeamId(e.target.value)}><option value="">Independent · private to you</option>{teams.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label><label>Starting pitcher<select required value={selected} onChange={e => setPitcherId(e.target.value)}>{eligible.map(p => <option key={p.id} value={p.id}>{p.name}{p.jersey ? ` · #${p.jersey}` : ''}</option>)}</select></label>{!eligible.length && <p className="form-intro">Assign an active pitcher to this team before starting.</p>}<p className="form-intro">This device records the practice. Pitches save here first, then sync when you’re online. The practice’s team stays fixed.</p><button type="submit" className="primary form-submit" disabled={disabled || !selected}>Let’s practice <Icon name="arrow" /></button></form>
}
function Notes({ session, draft, setDraft, disabled, save }: { session: Session; draft?: string; setDraft: (value: string) => void; disabled: boolean; save: (notes: string) => void }) {
  const notes = draft ?? session.notes
  return <section className="card notes"><form onSubmit={e => { e.preventDefault(); save(notes) }}><div className="section-heading"><label htmlFor={`notes-${session.id}`}>Coaching notes</label><button className="text-button" type="submit" disabled={disabled || notes === session.notes}>{notes === session.notes ? 'Notes saved' : 'Save notes'}<Icon name="check" size={16} /></button></div><textarea id={`notes-${session.id}`} value={notes} readOnly={disabled} onChange={e => setDraft(e.target.value)} placeholder="What clicked? What’s next? Leave a note for the next practice." rows={2} /></form></section>
}
