/**
 * The basketball draft screen.
 *
 * Read from the left: the clock and the pick (act), then where the build is
 * going and what is still open (decide), then the board (look things up).
 * The right column is context — my roster, what changed, who went where.
 *
 * Nothing here works anything out. The server sends the whole view, worked out
 * once per change, and this draws it; the screen polls every two seconds.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraftView, BoardRow, PathView } from '../../../nba/plan'
import type { Cat } from '../../../nba/value'

const CATS: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
const LABEL: Record<Cat, string> = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' }
const pct = (x: number) => `${Math.round(x * 100)}%`
const POSITIONS = ['All', 'PG', 'SG', 'SF', 'PF', 'C']

type Tag = 'never' | 'avoid' | 'like'

async function post(path: string, data: unknown = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

function useDraft(id: string) {
  const [view, setView] = useState<DraftView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/nba/draft/${id}`)
      if (res.status === 401) { setError('This companion is private — open it once with ?token='); return }
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
      setView(await res.json())
      setError(null)
    } catch (e) {
      setError(`Can't reach the companion (${(e as Error).message}) — showing the last board`)
    }
  }, [id])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])
  const act = useCallback(async (path: string, data?: unknown) => {
    try {
      await post(`/api/nba/draft/${id}/${path}`, data)
    } catch (e) {
      setError((e as Error).message)
    }
    refresh()
  }, [id, refresh])
  return { view, error, act }
}

// ── Entry ────────────────────────────────────────────────────────────────────

export function Draft() {
  const id = location.pathname.match(/^\/nba\/draft\/([\w-]+)/)?.[1] ?? null
  return id ? <Screen id={id} /> : <Pick />
}

function Pick() {
  const [leagues, setLeagues] = useState<{ id: string; label: string; scoring: string; teams: number; picks: number }[] | null>(null)
  useEffect(() => {
    fetch('/api/nba/leagues').then((r) => r.json()).then((ls) => {
      setLeagues(ls)
      if (ls.length === 1) location.replace(`/nba/draft/${ls[0].id}`)
    }).catch(() => setLeagues([]))
  }, [])
  return (
    <div className="nb-pick">
      <a className="nb-home" href="/home">← Home</a>
      <h1>Basketball draft</h1>
      {!leagues && <p className="nb-dim">Loading leagues…</p>}
      {leagues?.map((l) => (
        <a key={l.id} className="nb-league" href={`/nba/draft/${l.id}`}>
          <span className="nb-league-name">{l.label}</span>
          <span className="nb-dim">{l.scoring === 'points' ? 'Points' : '9-cat'} · {l.teams} teams{l.picks ? ` · ${l.picks} picks in` : ''}</span>
        </a>
      ))}
    </div>
  )
}

function Screen({ id }: { id: string }) {
  const { view, error, act } = useDraft(id)
  if (!view) return <div className="nb-pick"><p className="nb-dim">{error ?? 'Loading the board…'}</p></div>
  const cats = view.league.scoring === 'categories'
  return (
    <div className="nb">
      <Header view={view} error={error} />
      <div className="nb-cols">
        <section className="nb-act">
          <Clock view={view} act={act} />
          <TakeNow view={view} act={act} />
          <Entry id={id} view={view} act={act} />
        </section>
        <section className="nb-decide">
          {cats && <Build view={view} act={act} />}
          {cats && <Paths view={view} act={act} />}
          <Ahead view={view} />
          <Board view={view} act={act} />
        </section>
        <section className="nb-context">
          <Roster view={view} />
          <Feed view={view} />
          <Log view={view} />
        </section>
      </div>
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ view, error }: { view: DraftView; error: string | null }) {
  const s = view.sensor
  const age = s.at ? Math.round((Date.now() - s.at) / 1000) : null
  const tone = !s.at ? 'off' : !s.ok ? 'bad' : age! > 30 ? 'stale' : 'ok'
  const said = !s.at ? 'Yahoo sensor not heard from — keep a Yahoo basketball tab open, or enter picks by hand'
    : !s.ok ? `Yahoo sensor: ${s.error}` : `Yahoo · ${age}s ago${s.unresolved.length ? ` · couldn't place ${s.unresolved.slice(0, 3).join(', ')}` : ''}`
  return (
    <header className="nb-hdr">
      <a className="nb-home" href="/home">← Home</a>
      <div className="nb-title">
        <span>{view.league.label}</span>
        <span className="nb-badge">{view.league.scoring === 'points' ? 'Points' : '9-cat'} · {view.league.teams} teams</span>
        {view.league.slot != null && <span className="nb-badge">Seat {view.league.slot}{view.league.slotSource === 'yahoo' ? ' (Yahoo)' : ''}</span>}
      </div>
      <div className={`nb-sensor nb-${tone}`} title={said}>{said}</div>
      {error && <div className="nb-sensor nb-bad">{error}</div>}
    </header>
  )
}

// ── Act ──────────────────────────────────────────────────────────────────────

function Clock({ view, act }: { view: DraftView; act: (p: string, d?: unknown) => void }) {
  const c = view.clock
  if (view.league.slot == null) {
    return (
      <div className="nb-clock">
        <div className="nb-clock-big">Which seat are you?</div>
        <p className="nb-dim">Yahoo posts the order before the draft and the sensor reads it. Until then, set it here.</p>
        <div className="nb-seats">
          {Array.from({ length: view.league.teams }, (_, i) => (
            <button key={i} onClick={() => act('slot', { slot: i + 1 })}>{i + 1}</button>
          ))}
        </div>
      </div>
    )
  }
  if (c.done) return <div className="nb-clock"><div className="nb-clock-big">Draft complete</div></div>
  return (
    <div className={`nb-clock ${c.onClock ? 'nb-onclock' : ''}`}>
      <div className="nb-clock-big">{c.onClock ? 'On the clock' : `Your pick in ${c.picksUntil}`}</div>
      <div className="nb-dim">Pick {c.overall} · round {c.round}{c.myNext && !c.onClock ? ` · yours is ${c.myNext}` : ''}</div>
    </div>
  )
}

function reasons(contrib: Record<Cat, number> | undefined, locks: Cat[]) {
  if (!contrib) return { up: [] as Cat[], down: [] as Cat[] }
  const live = CATS.filter((c) => !locks.includes(c))
  const up = live.filter((c) => contrib[c] > 0.25).sort((a, b) => contrib[b] - contrib[a]).slice(0, 3)
  const down = live.filter((c) => contrib[c] < -0.25).sort((a, b) => contrib[a] - contrib[b]).slice(0, 2)
  return { up, down }
}

function TakeNow({ view, act }: { view: DraftView; act: (p: string, d?: unknown) => void }) {
  const [top, ...rest] = view.advice
  if (!top) return null
  const locks = view.build?.locks ?? []
  const why = (a: typeof top) => {
    const r = reasons(a.contrib, locks)
    return (
      <span className="nb-why">
        {r.up.map((c) => <span key={c} className="nb-up">+{LABEL[c]}</span>)}
        {r.down.map((c) => <span key={c} className="nb-down">−{LABEL[c]}</span>)}
        {a.fpg != null && <span>{a.fpg.toFixed(1)} fp/g</span>}
        <span className="nb-dim">{Math.round(a.gp)} g</span>
      </span>
    )
  }
  const after = (a: typeof top) => a.canWait
    ? <span className="nb-wait">{pct(a.survives)} he's back next turn — can wait</span>
    : <span className="nb-gone">{pct(1 - a.survives)} gone by your next turn</span>
  return (
    <div className="nb-take">
      <div className="nb-h">{view.clock.onClock ? 'Take' : 'If it were your pick'}</div>
      <div className="nb-top">
        <div className="nb-top-name">{top.name}{top.tag === 'like' && <span className="nb-tag nb-like">like</span>}{top.tag === 'avoid' && <span className="nb-tag nb-avoid">avoid</span>}</div>
        <div className="nb-dim">{top.team} · {top.positions.join(', ')}</div>
        {why(top)}
        <div>{after(top)}</div>
        <button className="nb-btn" onClick={() => act('pick', { playerId: top.id })}>Mark {top.name.split(' ').slice(-1)[0]} drafted</button>
      </div>
      <ul className="nb-alts">
        {rest.slice(0, 5).map((a) => (
          <li key={a.id}>
            <button className="nb-link" title="Mark drafted" onClick={() => act('pick', { playerId: a.id })}>{a.name}</button>
            <span className="nb-dim"> {a.positions.join(',')}</span>
            {a.tag === 'avoid' && <span className="nb-tag nb-avoid">avoid</span>}
            {why(a)}
            {a.canWait && <span className="nb-wait"> · can wait</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Entry({ id, view, act }: { id: string; view: DraftView; act: (p: string, d?: unknown) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ id: string; name: string; team: string | null; positions: string[] }[]>([])
  const box = useRef<HTMLInputElement>(null)
  const taken = useMemo(() => new Set(view.board.filter((r) => r.takenAt != null).map((r) => r.id)), [view.board])
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      fetch(`/api/nba/players?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((h) => setHits(h.filter((x: any) => !taken.has(x.id))))
    }, 120)
    return () => clearTimeout(t)
  }, [q, taken])
  // "/" focuses the box from anywhere, so a pick is two keystrokes and a name.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== box.current) { e.preventDefault(); box.current?.focus() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  const pick = (playerId: string) => { act('pick', { playerId }); setQ(''); setHits([]) }
  return (
    <div className="nb-entry">
      <div className="nb-h">Enter a pick <span className="nb-dim">— any team; press / to jump here</span></div>
      <div className="nb-entry-row">
        <input ref={box} value={q} placeholder="Player name" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) pick(hits[0].id); if (e.key === 'Escape') setQ('') }} />
        <button className="nb-btn nb-quiet" onClick={() => act('undo')}>Undo</button>
      </div>
      {hits.length > 0 && (
        <ul className="nb-hits">
          {hits.map((h, i) => (
            <li key={h.id}><button className={i === 0 ? 'nb-first' : ''} onClick={() => pick(h.id)}>{h.name} <span className="nb-dim">{h.team} · {h.positions.join(',')}</span></button></li>
          ))}
        </ul>
      )}
      <p className="nb-dim nb-small">Picks Yahoo reports replace typed ones; undo takes back the last one you typed. Next pick is {view.clock.overall}.</p>
    </div>
  )
}

// ── Decide ───────────────────────────────────────────────────────────────────

function Build({ view, act }: { view: DraftView; act: (p: string, d?: unknown) => void }) {
  const b = view.build!
  const toggle = (c: Cat) => act('locks', { locks: b.locks.includes(c) ? b.locks.filter((x) => x !== c) : [...b.locks, c] })
  const made = view.roster.length
  const state = (c: Cat) => {
    if (b.locks.includes(c)) return 'locked'
    if (!b.win) return 'open'
    const w = b.win[c]
    return w < 0.35 ? 'punt' : w < 0.5 ? 'edge' : w >= 0.65 ? 'strong' : 'even'
  }
  return (
    <div className="nb-panel">
      <div className="nb-h">
        Your build
        <span className={`nb-stage nb-stage-${b.stage}`}>
          {b.stage === 'open' ? `open — read from pick ${b.buildFrom} (${made} made)` : b.stage === 'leaning' ? `leaning — firm from pick ${b.buildFirm}` : 'firm'}
        </span>
        {b.expected != null && <span className="nb-dim"> · now {b.expected.toFixed(1)} of 9 a week vs an average team at this stage</span>}
      </div>
      <div className="nb-cats">
        {CATS.map((c) => (
          <button key={c} className={`nb-cat nb-cat-${state(c)}`} onClick={() => toggle(c)}
            title={b.locks.includes(c) ? 'Locked as a punt — click to unlock' : 'Click to lock as a punt'}>
            <span className="nb-cat-l">{LABEL[c]}</span>
            <span className="nb-cat-v">{b.locks.includes(c) ? 'punt 🔒' : b.win ? pct(b.win[c]) : '—'}</span>
          </button>
        ))}
      </div>
      <p className="nb-dim nb-small">
        {b.stage === 'open'
          ? 'Weekly win chance per category appears from your fourth pick; until then the advice is the best player, not a fit. Click a category to lock it as a punt at any time.'
          : `${b.punting.length ? `Punting ${b.punting.map((c) => LABEL[c]).join(', ')}. ` : 'Nothing given up. '}${b.edge.length ? `On the edge: ${b.edge.map((c) => LABEL[c]).join(', ')}. ` : ''}${b.locks.length ? `Locked: ${b.locks.map((c) => LABEL[c]).join(', ')} — the advice ignores them.` : 'Click a category to lock it as a punt.'}`}
      </p>
    </div>
  )
}

function Paths({ view, act }: { view: DraftView; act: (p: string, d?: unknown) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const ps = view.paths
  if (!ps.length) return null
  const best = ps[0].expected
  const shown = [...ps.slice(0, 4), ...ps.filter((p, i) => i >= 4 && p.locked)]
  const lock = (p: PathView) => act('locks', { locks: p.locked ? [] : p.punt })
  return (
    <div className="nb-panel">
      <div className="nb-h">Paths from here <span className="nb-dim">— each drafted forward against a room that follows Yahoo ADP</span></div>
      <ul className="nb-paths">
        {shown.map((p) => (
          <li key={p.name} className={p.locked ? 'nb-path-locked' : ''}>
            <button className="nb-path-row" onClick={() => setOpen(open === p.name ? null : p.name)}>
              <span className="nb-path-name">{p.name}</span>
              {p.leading && <span className="nb-tag nb-lead">best</span>}
              {p.locked && <span className="nb-tag nb-lockt">locked</span>}
              <span className="nb-path-e">{p.expected.toFixed(2)}</span>
              <span className="nb-dim nb-path-d">{p.leading ? '' : `−${(best - p.expected).toFixed(2)}`}</span>
            </button>
            {(p.punt.length > 0 || (view.build?.locks.length ?? 0) > 0) && (
              <button className="nb-btn nb-quiet nb-small" onClick={() => lock(p)}>{p.locked ? 'Unlock' : p.punt.length ? 'Lock' : 'Clear locks'}</button>
            )}
            {open === p.name && (
              <div className="nb-plan">{p.plan.map((x) => <span key={x.overall}>R{x.round} · {x.name}</span>)}</div>
            )}
          </li>
        ))}
      </ul>
      <p className="nb-dim nb-small">Expected categories won a week by the end of the draft. Close scores are a tie: a real room strays from ADP.</p>
    </div>
  )
}

function Ahead({ view }: { view: DraftView }) {
  if (!view.ahead.length) return null
  return (
    <div className="nb-panel">
      <div className="nb-h">Targets for your next picks <span className="nb-dim">— {view.aheadBuild}</span></div>
      <ul className="nb-ahead">
        {view.ahead.map((a) => (
          <li key={a.overall}>
            <span className="nb-ahead-when">R{a.round} · #{a.overall} <span className="nb-dim">in {a.overall - view.clock.overall}</span></span>
            <span className="nb-ahead-who">
              {a.players.map((p) => (
                <span key={p.id} className={p.planned ? 'nb-planned' : ''}>{p.name} <span className="nb-dim">{p.positions[0]} {pct(p.survives)}</span></span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="nb-dim nb-small">First name is the plan's pick; the others are worth having and likely there. Percent: chance he lasts to that pick.</p>
    </div>
  )
}

function Board({ view, act }: { view: DraftView; act: (p: string, d?: unknown) => void }) {
  const [pos, setPos] = useState('All')
  const [q, setQ] = useState('')
  const [showTaken, setShowTaken] = useState(false)
  const cats = view.league.scoring === 'categories'
  const locks = view.build?.locks ?? []
  const rows = view.board.filter((r) =>
    (showTaken || r.takenAt == null) &&
    (pos === 'All' || r.positions.includes(pos)) &&
    (!q || r.name.toLowerCase().includes(q.toLowerCase()))).slice(0, 150)
  const tag = (r: BoardRow, t: Tag) => act('tag', { playerId: r.id, tag: r.tag === t ? null : t })
  const heat = (v: number) => {
    const a = Math.min(1, Math.abs(v) / 1.2) * 0.55
    return { background: v >= 0 ? `rgba(69,217,160,${a})` : `rgba(255,92,99,${a})` }
  }
  return (
    <div className="nb-panel nb-board">
      <div className="nb-h">Board <span className="nb-dim">— ranked for {cats ? (locks.length ? `your locked punt` : view.aheadBuild || 'balanced') : 'points'}</span></div>
      <div className="nb-board-ctl">
        <input value={q} placeholder="Filter" onChange={(e) => setQ(e.target.value)} />
        <div className="nb-seg">{POSITIONS.map((p) => <button key={p} className={pos === p ? 'nb-on' : ''} onClick={() => setPos(p)}>{p}</button>)}</div>
        <label className="nb-dim"><input type="checkbox" checked={showTaken} onChange={(e) => setShowTaken(e.target.checked)} /> drafted</label>
      </div>
      <div className="nb-table-wrap">
        <table className="nb-table">
          <thead>
            <tr>
              <th>#</th><th className="nb-l">Player</th><th>Pos</th><th>G</th><th>ADP</th><th title="Chance he lasts to your next decision — the pick after this one when you are on the clock">Next</th>
              {cats ? CATS.map((c) => <th key={c} className={locks.includes(c) ? 'nb-col-off' : ''}>{LABEL[c]}</th>) : <><th>FP/g</th><th>Value</th></>}
              <th title="never · avoid · like">Tag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`${r.tag === 'never' ? 'nb-never' : ''} ${r.takenAt != null ? 'nb-taken' : ''} ${r.mine ? 'nb-mine' : ''}`}>
                <td className="nb-dim">{r.rank}</td>
                <td className="nb-l">
                  {r.name}
                  {r.injury && <span className="nb-inj">{r.injury}</span>}
                  {r.tag && <span className={`nb-tag nb-${r.tag}`}>{r.tag}</span>}
                  {r.takenAt != null && <span className="nb-dim nb-small"> #{r.takenAt}{r.takenBy ? ` ${r.takenBy}` : ''}</span>}
                  <span className="nb-dim nb-small"> {r.team}</span>
                </td>
                <td className="nb-dim">{r.positions.join(',')}</td>
                <td>{Math.round(r.gp)}</td>
                <td className="nb-dim">{r.adp != null ? r.adp.toFixed(0) : '—'}</td>
                <td>{r.takenAt == null && r.survives != null ? pct(r.survives) : ''}</td>
                {cats ? CATS.map((c) => (
                  <td key={c} className={`nb-num ${locks.includes(c) ? 'nb-col-off' : ''}`} style={locks.includes(c) ? undefined : heat(r.contrib![c])}>{r.contrib![c].toFixed(1)}</td>
                )) : <><td className="nb-num">{r.fpg?.toFixed(1)}</td><td className="nb-num">{Math.round(r.value)}</td></>}
                <td className="nb-tags">
                  <button className={r.tag === 'never' ? 'nb-on' : ''} title="Never draft" onClick={() => tag(r, 'never')}>✕</button>
                  <button className={r.tag === 'avoid' ? 'nb-on' : ''} title="Avoid" onClick={() => tag(r, 'avoid')}>↓</button>
                  <button className={r.tag === 'like' ? 'nb-on' : ''} title="Like" onClick={() => tag(r, 'like')}>★</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="nb-dim nb-small">
        {cats ? 'Category cells: season contribution, per-game strength weighted by games played. ' : ''}
        Never-list players stay on the board, greyed, so you can see where they go; the advice never offers them.
      </p>
    </div>
  )
}

// ── Context ──────────────────────────────────────────────────────────────────

function Roster({ view }: { view: DraftView }) {
  return (
    <div className="nb-panel">
      <div className="nb-h">Your roster <span className="nb-dim">{view.roster.length} of {view.league.rounds}</span></div>
      {view.openSeats.length > 0 && view.roster.length > 0 && <div className="nb-need">Still need: {view.openSeats.join(', ')}</div>}
      <ol className="nb-roster">
        {view.roster.map((r) => <li key={r.id}><span className="nb-dim">R{r.round}</span> {r.name} <span className="nb-dim">{r.positions.join(',')}</span></li>)}
        {!view.roster.length && <li className="nb-dim">No picks yet.</li>}
      </ol>
    </div>
  )
}

function Feed({ view }: { view: DraftView }) {
  if (!view.feed.length) return null
  return (
    <div className="nb-panel">
      <div className="nb-h">What changed</div>
      <ul className="nb-feed">
        {view.feed.map((f, i) => <li key={i} className={`nb-feed-${f.kind}`}>{f.text}</li>)}
      </ul>
    </div>
  )
}

function Log({ view }: { view: DraftView }) {
  return (
    <div className="nb-panel">
      <div className="nb-h">Draft log</div>
      <ol className="nb-log">
        {view.log.map((l) => (
          <li key={l.overall} className={l.mine ? 'nb-mine' : ''}><span className="nb-dim">#{l.overall}</span> {l.name} <span className="nb-dim">{l.manager ?? ''}</span></li>
        ))}
        {!view.log.length && <li className="nb-dim">Nothing drafted yet.</li>}
      </ol>
    </div>
  )
}
