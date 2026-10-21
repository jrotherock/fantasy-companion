/**
 * One basketball league's season, in the cockpit's look.
 *
 * Basketball is a daily game, so the first tab is today: is the lineup right,
 * and if not, what to change before which tip. Then the week (where it can
 * still be won), adds (what is left to spend and on whom), news, and the
 * season-long views — power, luck, the playoff weeks, trades.
 *
 * The server works everything out (src/nba/seasonView.ts); this only draws it.
 */
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SeasonView } from '../../../nba/seasonView'
import type { CatRace } from '../../../nba/matchup'
import type { Cat } from '../../../nba/value'
import { LeagueSize } from './LeagueSize'

const LABEL: Record<Cat, string> = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' }
const pct = (x: number) => `${Math.round(x * 100)}%`
const TABS = ['Today', 'Week', 'Adds', 'News', 'Season'] as const
type Tab = typeof TABS[number]

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '')
const day = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

function useSeason(id: string) {
  const [view, setView] = useState<SeasonView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/nba/season/${id}${force ? '/refresh' : ''}`, force ? { method: 'POST' } : undefined)
      if (res.status === 401) { setError('Sign in on the home screen first'); return }
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
      setView(await res.json())
      setError(null)
    } catch (e) {
      setError(`Can't reach the companion (${(e as Error).message})`)
    }
  }, [id])
  useEffect(() => {
    refresh()
    const t = setInterval(() => refresh(), 60000)
    return () => clearInterval(t)
  }, [refresh])
  return { view, error, refresh }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="nl-sect">
      <h2 className="nl-h">{title}{hint && <span className="nl-hint">{hint}</span>}</h2>
      {children}
    </section>
  )
}

/**
 * One basketball league, inside the home app under its tab bar. Before the
 * draft it is the league's draft prep — the draft room, mocks and what they
 * say; after it, the season.
 */
export function NbaLeague({ id, onBack }: { id: string; onBack: () => void }) {
  const { view, error, refresh } = useSeason(id)
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem(`nl-tab-${id}`) as Tab) || 'Today' } catch { return 'Today' } })
  useEffect(() => { try { sessionStorage.setItem(`nl-tab-${id}`, tab) } catch { /* private window */ } }, [id, tab])
  const crumb = <div className="ckcrumb"><button onClick={onBack}>‹ Now</button></div>
  if (!view) return <div className="nl">{crumb}<div className="ckempty">{error ?? 'Reading the league…'}</div></div>
  const v = view
  const rec = v.standing && v.standing.w != null ? `${v.standing.w}-${v.standing.l}${v.standing.t ? `-${v.standing.t}` : ''}${v.standing.rank ? ` · ${ordinal(v.standing.rank)}` : ''}` : null
  return (
    <div className="nl">
      {crumb}
      <header className="ckhdr">
        <div className="ckbig">{v.league.label}</div>
        <div className="cksub">
          {v.league.scoring === 'categories' ? '9-cat' : 'Points'} · {v.league.teams} teams
          {v.myTeam?.name ? ` · ${v.myTeam.name}` : ''}{rec ? ` · ${rec}` : ''}
          <span className="nl-fresh"> · {v.at ? `read ${ago(v.at)}` : 'not read yet'} <button className="nl-link" onClick={() => refresh(true)}>refresh</button></span>
        </div>
      </header>
      {error && <div className="nl-warn">{error}</div>}
      {v.phase === 'before-draft' ? <Prep leagueId={v.league.id} /> : (
        <>
          <div className="ckseg" role="tablist">
            {TABS.map((o) => <button key={o} role="tab" aria-selected={o === tab} className={o === tab ? 'on' : ''} onClick={() => setTab(o)}>{o}</button>)}
          </div>
          {tab === 'Today' && <Today v={v} />}
          {tab === 'Week' && <Week v={v} />}
          {tab === 'Adds' && <Adds v={v} />}
          {tab === 'News' && <News v={v} />}
          {tab === 'Season' && <Season v={v} onChange={() => refresh()} />}
        </>
      )}
    </div>
  )
}

// ── Before the draft: the league's draft prep ──

type DraftLeague = { id: string; label: string; scoring: string; teams: number; picks: number; mock: { baseId: string; apiOk: boolean | null; createdAt: number } | null }
type Lesson = { leagueId: string; label: string; scoring: string; report: import('../../../nba/tendencies').MockReport }

async function post(path: string, data: unknown = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
  return res.json()
}

type TakeByView = {
  slot: number; teams: number; knownSlot: number | null
  gone: { id: string; name: string; rank: number; adp: number; chance: number }[]
  picks: { overall: number; also?: number; round: number; players: { id: string; name: string; team: string | null; positions: string[]; rank: number; adp: number; chance: number; simMark: { kind: 'up' | 'lean' | 'down'; gap: number } | null }[] }[]
}

/**
 * Where your picks land: for each of your first turns, the best players (by value) likely still
 * there then but gone by your next — what you will be choosing from. Prep only: in the draft the
 * cards already weigh who comes back.
 */
function TakeBySection({ leagueId }: { leagueId: string }) {
  const key = `takeby-slot-${leagueId}`
  const [slot, setSlot] = useState<number | null>(() => { try { const v = localStorage.getItem(key); return v ? Number(v) : null } catch { return null } })
  const [tb, setTb] = useState<TakeByView | null>(null)
  const [sized, setSized] = useState(0)
  useEffect(() => {
    fetch(`/api/nba/takeby/${leagueId}${slot ? `?slot=${slot}` : ''}`).then((r) => r.json()).then((x) => { if (x?.picks) setTb(x) }).catch(() => {})
  }, [leagueId, slot, sized])
  const choose = (n: number) => { setSlot(n); try { localStorage.setItem(key, String(n)) } catch { /* private window */ } }
  if (!tb) return null
  const pc = (x: number) => `${Math.round(x * 100)}%`
  return (
    <Section title="Where your picks land" hint="by value, among those likely still there">
      {!leagueId.startsWith('nba-mock-') && <LeagueSize leagueId={leagueId} onChange={() => setSized((n) => n + 1)} />}
      <div className="nl-slots">
        <span className="nl-dim">Your slot</span>
        {Array.from({ length: tb.teams }, (_, i) => i + 1).map((n) => (
          <button key={n} className={`nl-slot ${n === tb.slot ? 'on' : ''}`} onClick={() => choose(n)}>{n}</button>
        ))}
        {tb.knownSlot != null && tb.knownSlot !== tb.slot && <button className="nl-link" onClick={() => choose(tb.knownSlot!)}>yours is {tb.knownSlot}</button>}
      </div>
      {tb.gone.length > 0 && <p className="nl-note">Likely gone before your first pick: {tb.gone.map((g) => g.name).join(', ')}.</p>}
      {tb.picks.map((g, i) => {
        // Pick numbers count picks, not turns: a turn at the snake's end holds two.
        const n = tb.picks.slice(0, i).reduce((k, x) => k + (x.also ? 2 : 1), 1)
        return (
        <div key={g.overall} className="nl-takeby">
          <div className="nl-takebyh">{g.also
            ? <>Your picks {n}–{n + 1} <span className="nl-dim">· back to back, rounds {g.round}–{g.round + 1}, #{g.overall} &amp; #{g.also}</span></>
            : <>Your pick {n} <span className="nl-dim">· round {g.round}, #{g.overall}</span></>}</div>
          {g.players.length === 0 ? <div className="nl-dim">—</div> : (
            <div className="nl-takebylist">{g.players.map((p) => (
              <span key={p.id}><b>{p.name}</b> <span className="nl-dim">#{p.rank}{p.simMark ? ` ${p.simMark.kind === 'down' ? '▼' : p.simMark.kind === 'up' ? '▲' : '△'}` : ''} · ADP {Math.round(p.adp)} · {pc(p.chance)}</span></span>
            ))}</div>
          )}
        </div>
        )
      })}
      <p className="nl-note">Each player sits at the last of your picks where he is more likely there than not; # is the board's order (the simulations' top 5, then by usual round where the league has a Draft rank, else value; ▼ the simulations say let him go, ▲ they like him more than his round, △ a lean), the % his chance at that pick. Grouped by when players go, not tiers of value; in the draft itself the cards already weigh who will be back.</p>
    </Section>
  )
}

/**
 * Everything for getting ready: the draft room, this league's mocks, and what
 * they say. Mocks copy this league's settings; their lessons are kept apart
 * from the other league's, since points and categories teach different things.
 */
function Prep({ leagueId }: { leagueId: string }) {
  const [all, setAll] = useState<DraftLeague[] | null>(null)
  const [lessons, setLessons] = useState<Lesson[] | null>(null)
  const [link, setLink] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const base = leagueId.replace(/-test$/, '')
  const load = () => {
    fetch('/api/nba/leagues?all=1').then((r) => r.json()).then(setAll).catch(() => setAll([]))
    fetch('/api/nba/tendencies').then((r) => r.json()).then(setLessons).catch(() => setLessons([]))
  }
  useEffect(load, [])
  useEffect(() => { if (location.hash === '#mocks') document.getElementById('mocks')?.scrollIntoView() }, [lessons])
  const me = all?.find((l) => l.id === leagueId)
  const mocks = (all ?? []).filter((l) => l.mock?.baseId === base).sort((a, b) => b.mock!.createdAt - a.mock!.createdAt)
  const lesson = lessons?.find((l) => l.leagueId === base)
  const follow = async () => {
    setErr(null)
    try {
      const r = await post('/api/nba/mock', { link, baseId: base })
      location.href = `/nba/draft/${r.leagueId}`
    } catch (e) { setErr((e as Error).message) }
  }
  const discard = async (id: string) => { await post(`/api/nba/draft/${id}/discard`); load() }
  const cats = lesson?.report.scoring === 'categories'
  const fmt = (x: number) => (cats ? x.toFixed(2) : Math.round(x).toLocaleString())
  const place = (n: number | null | undefined, of: number | undefined) => (n == null || !of ? '—' : <>{ordinal(n)} <span className="nl-dim">of {of}</span></>)
  return (
    <>
      <a className="nl-room" href={`/nba/draft/${leagueId}`}>
        <span className="nl-roomk">Draft room</span>
        <span>{me?.picks ? `${me.picks} picks in — resume` : 'Open it when the draft starts; Yahoo\u2019s picks arrive by themselves'}</span>
        <span className="ckchev">›</span>
      </a>
      <TakeBySection leagueId={leagueId} />
      <Section title="Mock drafts" hint="each copies this league">
        <p className="nl-note" style={{ marginTop: 0 }}>Start an Instant Mock Draft on Yahoo with the extension loaded and it appears here by itself. If it does not, paste the room's address.</p>
        {mocks.map((m) => (
          <div key={m.id} className="nl-mock">
            <a href={`/nba/draft/${m.id}`}>{new Date(m.mock!.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</a>
            <span className="nl-dim"> · {m.picks} picks · {m.mock!.apiOk === true ? 'read by the Yahoo API' : m.mock!.apiOk === false ? 'read by the extension' : 'checking the API…'}</span>
            <span className="cksp" /><button className="nl-link" onClick={() => discard(m.id)}>Discard</button>
          </div>
        ))}
        <div className="nl-follow">
          <input className="field" value={link} placeholder="Mock draft room address" onChange={(e) => setLink(e.target.value)} />
          <button className="ckbtn" onClick={follow} disabled={!link.trim()}>Follow</button>
        </div>
        {err && <div className="nl-warn">{err}</div>}
      </Section>
      <section className="nl-sect" id="mocks">
        <h2 className="nl-h">What your mocks say{lesson && <span className="nl-hint">{lesson.report.headline}</span>}</h2>
        {!lesson ? <div className="nl-none">No finished mocks yet.</div> : (() => {
          const r = lesson.report
          return <>
            {r.playbook.length > 0 && (
              <ol className="nl-playbook">
                {r.playbook.map((p) => (
                  <li key={p.id}>
                    <div><b>{p.action}</b> <span className="nl-kind">{p.strength}</span></div>
                    <div className="nl-dim">When: {p.when} · Because: {p.because} · Check: {p.check}</div>
                  </li>
                ))}
              </ol>
            )}
            {r.tendencies.map((t) => (
              <div key={t.id} className="nl-news"><div className="nl-newsh">{t.headline} <span className="nl-kind">{t.strength}</span></div><div className="nl-dim">{t.detail}{t.tryNext ? ` Try: ${t.tryNext}` : ''}</div></div>
            ))}
            {r.table.length > 0 && (
              <table className="nl-table">
                <thead><tr><th className="l">Mock</th><th title="Your draft position: where you picked in round one">Pick</th>
                  {cats
                    ? <><th className="l" title="The punt your roster ended with, or the one you locked">Build</th><th title="Categories a week against an average team">Cats/wk</th><th title="Where that placed in the room">Place</th></>
                    : <><th title="Season value over replacement: points a game above the waiver line, times games, summed over your roster">Value</th><th title="Your roster's fantasy points over the season: a game times games">FP season</th><th title="Where your season points placed against every other team's in the mock">Place</th></>}
                  <th title="Picks where you took what the cards advised">Advice</th></tr></thead>
                <tbody>{r.table.map((m) => (
                  <tr key={m.id}>
                    <td className="l"><a href={`/nba/draft/${m.id}`}>{m.when ? new Date(m.when).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : m.id}</a></td>
                    <td>{m.seat ?? '—'}</td>
                    {cats
                      ? <><td className="l">{m.build}</td><td>{fmt(m.result)}</td><td>{place(m.place?.result, m.place?.of)}</td></>
                      : <><td>{fmt(m.result)}</td><td>{m.fpSeason != null ? Math.round(m.fpSeason).toLocaleString() : '—'}</td><td>{place(m.place?.fpSeason, m.place?.of)}</td></>}
                    <td>{m.followed}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="nl-note">{cats
              ? 'Cats/wk: categories your roster wins a week against an average team. Build: the categories it gave up. Place is against the other teams in the mock, which are Yahoo\u2019s bots.'
              : 'Value: points a game above the waiver line, times games, over your roster — what the board ranks by. FP season: every drafted player\u2019s projected points a game, at Harker\u2019s scoring, times his games, added up; bench games are counted, so it runs above what a 7-seat lineup would score. Value is the one to compare. Place is against the other teams in the mock, which are Yahoo\u2019s bots.'}
              {' '}{r.caveat}</p>
          </>
        })()}
      </section>
    </>
  )
}

const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

// ── Today ──

/**
 * A designation with what is known behind it, as football's screens show it: the code on the row, and on hover
 * (or a tap, which focuses it) a card with the status, the note, the chance he plays and a way out to the news.
 */
const SEVERITY: Record<string, string> = { out: 'likely-out', injured: 'likely-out', suspended: 'likely-out', inactive: 'likely-out', doubtful: 'likely-out', questionable: 'coin-flip', probable: 'likely-plays' }
function InjuryTag({ r }: { r: NonNullable<SeasonView['lineup']>['rows'][number] }) {
  return (
    <span className="ckinjwrap">
      <span className={`ckinj ${SEVERITY[r.status] ?? 'coin-flip'}`} tabIndex={0} role="button" aria-label={`${r.status} — what is known`}>{r.code ?? r.status}</span>
      <span className="ckinjcard">
        <span className="ckics">{r.status[0].toUpperCase() + r.status.slice(1)}</span>
        {r.game && <span className="ckicr">Plays {pct(r.play)}</span>}
        {r.note ? <span className="ckicn">{r.note}</span> : <span className="ckicn dim">No note published</span>}
        <a className="ckicl" href={`https://www.google.com/search?q=${encodeURIComponent(`${r.name} injury news`)}&tbm=nws`} target="_blank" rel="noreferrer noopener">Search the news ›</a>
      </span>
    </span>
  )
}

function Today({ v }: { v: SeasonView }) {
  const l = v.lineup
  const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
  if (!l) return <div className="ckempty">{v.startsOn ? `No games yet: the season starts ${dateWord(v.startsOn)}${v.week?.opponent ? `, week 1 against ${v.week.opponent.name}` : ''}.` : "Today's lineup has not been read yet."}</div>
  const first = l.moves.map((m) => m.by).filter(Boolean).sort()[0] ?? null
  const order = (s: string | null) => ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'Util', 'BN', 'IL', 'IL+'].indexOf(s ?? 'BN')
  const sorted = [...l.rows].sort((a, b) => order(a.slot) - order(b.slot))
  const out = (r: typeof sorted[number]) => r.slot === 'IL' || r.slot === 'IL+' || r.status === 'out' || r.status === 'injured'
  const tonight = sorted.filter((r) => r.game && !out(r))
  const noGame = sorted.filter((r) => !r.game && !out(r))
  const hurt = sorted.filter(out)
  const gamesToday = l.rows.some((r) => r.game)
  const actions = l.moves.length + l.ilMoves.length
  return (
    <>
      {/* One block for everything to do before tip: the verdict, the moves, IL, and tonight in a line. */}
      <div className={`nl-act ${actions ? 'fix' : 'ok'}`}>
        <div className="nl-acth">
          {actions
            ? `${actions} thing${actions === 1 ? '' : 's'} to do${first ? ` — first by ${time(first)}` : ''}`
            : gamesToday ? 'Lineup is right for tonight' : v.startsOn ? `The season starts ${dateWord(v.startsOn)}${v.week?.opponent ? ` — week 1 against ${v.week.opponent.name}` : ''}` : 'No games for your players today'}
        </div>
        {gamesToday && (
          <div className="nl-acts">
            <b>{l.playing}</b> of yours play tonight · {l.emptyTonight > 0 ? <><b>{l.emptyTonight}</b> empty spot{l.emptyTonight === 1 ? '' : 's'}</> : 'every spot filled'}
            {l.firstLock && <> · first lock <b>{time(l.firstLock)}</b></>}
            {l.lostStarts > 0 && <> · <span className="nl-cost">{l.lostStarts} start{l.lostStarts === 1 ? '' : 's'} lost as it stands</span></>}
          </div>
        )}
        {actions > 0 && (
          <ul className="nl-moves">
            {l.moves.map((m) => (
              <li key={m.start}><b>Start {name(m.start)}</b>{m.bench && <> for <b>{name(m.bench)}</b></>}<span className="nl-why">{m.why}{m.by ? ` · by ${time(m.by)}` : ''}</span></li>
            ))}
            {l.ilMoves.map((m) => (
              <li key={m.id}><b className="nl-amber">{m.action === 'to-il' ? `Move ${m.name} to IL` : `Take ${m.name} off IL`}</b><span className="nl-why">{m.why}</span></li>
            ))}
          </ul>
        )}
      </div>
      <Tomorrow v={v} />
      {gamesToday
        ? <>
            <RosterGroup title="Playing tonight" rows={tonight} points={v.league.points} total />
            <RosterGroup title="No game today" rows={noGame} points={v.league.points} />
          </>
        : <RosterGroup title={v.startsOn ? 'Your roster' : 'Next games'} rows={[...tonight, ...noGame]} preseason={!!v.startsOn} points={v.league.points} />}
      {hurt.length > 0 && <RosterGroup title="Out or on IL" rows={hurt} preseason={!!v.startsOn} points={v.league.points} />}
      <p className="nl-note">Yahoo locks each player at his game's tip. Once his game starts, each cell is what he has done, read from Yahoo about every ten minutes, shaded green where he is ahead of his projection and red where he is behind, deeper the further (part way through a game, against the share of it played so far). Before then, the italic numbers are his projection for tonight or his next game. "Games" is how many games his team plays in the matchup week from today on.</p>
    </>
  )
}

/**
 * Tomorrow's lineup as set, a day ahead: Yahoo keeps a lineup for each day, and one left as today's can start players
 * whose teams do not play while bench players who do sit (2026-10-20: Harden, Murray and Allen started a Wednesday
 * their teams were off, Wilson, Powell and Turner on the bench). Shown whenever tomorrow's needs a change; a quiet
 * "right" only once tonight has nothing left to set.
 */
function Tomorrow({ v }: { v: SeasonView }) {
  const t = v.tomorrow
  if (!t) return null
  const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
  const tonightLeft = (v.lineup?.rows ?? []).some((r) => r.game && !r.game.started)
  if (!t.moves.length) return tonightLeft ? null : <div className="nl-act ok nl-tomorrow"><div className="nl-acth">Tomorrow's lineup is right <span className="nl-dim">· {dateWord(t.date)}, {t.playing} of yours play</span></div></div>
  const lost = t.lostStarts
  return (
    <div className="nl-act fix nl-tomorrow">
      <div className="nl-acth">Tomorrow, {dateWord(t.date)}: {t.moves.length} change{t.moves.length === 1 ? '' : 's'} to the lineup as set{lost ? <span className="nl-cost"> · {lost} start{lost === 1 ? '' : 's'} lost otherwise</span> : null}</div>
      <ul className="nl-moves">
        {t.moves.map((m) => (
          <li key={m.start}><b>Start {name(m.start)}</b>{m.bench && <> for <b>{name(m.bench)}</b></>}<span className="nl-why">{m.why}{m.by ? ` · his game tips ${time(m.by)}` : ''}</span></li>
        ))}
      </ul>
      <div className="nl-acts nl-dim">Yahoo keeps a lineup for each day: set tomorrow's in Yahoo (pick the date) any time before each tip.</div>
    </div>
  )
}

// ── Up or down, and by how much ──

type Box = NonNullable<NonNullable<SeasonView['lineup']>['rows'][number]['tonight']>
type CatKey = 'fg' | 'ft' | 'tpm' | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'to'
/** What a full shade takes in each counting category, a game's worth or so. */
const UNIT: Record<string, number> = { tpm: 1.5, pts: 6, reb: 3, ast: 3, stl: 1, blk: 1, to: 1.5 }
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x))
/**
 * How far a line runs from what it is measured against: −1 well short, 1 well past; 0 for about the same. A
 * percentage on a handful of attempts says little, so it is shaded less. Turnovers: fewer is better.
 */
function heat(cat: CatKey, a: Box, p: Box): number {
  if (cat === 'fg' || cat === 'ft') {
    const m = cat === 'fg' ? 'fgm' : 'ftm', at = cat === 'fg' ? 'fga' : 'fta'
    if (!a[at] || !p[at]) return 0
    const d = a[m] / a[at] - p[m] / p[at]
    return clamp1((d / 0.12) * Math.min(1, a[at] / Math.max(1, p[at])))
  }
  const x = (a[cat] - p[cat]) / Math.max(UNIT[cat], p[cat] * 0.5)
  return clamp1(cat === 'to' ? -x : x)
}
/** A shade for a cell: green up, red down, deeper the further; nothing for about the same. */
const shade = (x: number) => (Math.abs(x) < 0.15 ? undefined : { background: `color-mix(in srgb, var(${x > 0 ? '--green' : '--red'}) ${Math.round(8 + Math.abs(x) * 26)}%, transparent)` })
const scaleBox = (b: Box, f: number): Box => Object.fromEntries(Object.entries(b).map(([k, x]) => [k, (x as number) * f])) as unknown as Box
const sumBox = (bs: Box[]): Box => bs.reduce((a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + (b as any)[k]])) as Box, { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0 } as Box)

/** Today's columns, in Yahoo's order: makes and attempts beside each percentage, then the counting categories. */
const TCOLS: { key: string; label: string; cat: CatKey | null; cell: (b: Box, real: boolean) => string }[] = [
  { key: 'fgma', label: 'FGM/A', cat: null, cell: (b, real) => (real ? `${b.fgm}/${b.fga}` : `${b.fgm.toFixed(1)}/${b.fga.toFixed(1)}`) },
  { key: 'fg', label: 'FG%', cat: 'fg', cell: (b) => rate(b.fgm, b.fga) },
  { key: 'ftma', label: 'FTM/A', cat: null, cell: (b, real) => (real ? `${b.ftm}/${b.fta}` : `${b.ftm.toFixed(1)}/${b.fta.toFixed(1)}`) },
  { key: 'ft', label: 'FT%', cat: 'ft', cell: (b) => rate(b.ftm, b.fta) },
  { key: 'tpm', label: '3PTM', cat: 'tpm', cell: (b, real) => one(b.tpm, real) },
  { key: 'pts', label: 'PTS', cat: 'pts', cell: (b) => Math.round(b.pts).toString() },
  { key: 'reb', label: 'REB', cat: 'reb', cell: (b, real) => one(b.reb, real) },
  { key: 'ast', label: 'AST', cat: 'ast', cell: (b, real) => one(b.ast, real) },
  { key: 'stl', label: 'ST', cat: 'stl', cell: (b, real) => one(b.stl, real) },
  { key: 'blk', label: 'BLK', cat: 'blk', cell: (b, real) => one(b.blk, real) },
  { key: 'to', label: 'TO', cat: 'to', cell: (b, real) => one(b.to, real) },
]
const one = (x: number, whole: boolean) => (whole ? Math.round(x).toString() : x.toFixed(1))
const rate = (m: number, a: number) => (a > 0 ? (m / a).toFixed(3).replace(/^0/, '') : '—')
/** Fantasy points from a line at a points league's weights. */
const fpOf = (b: Box, w: NonNullable<SeasonView['league']['points']>) =>
  (w.pts ?? 0) * b.pts + (w.reb ?? 0) * b.reb + (w.ast ?? 0) * b.ast + (w.stl ?? 0) * b.stl + (w.blk ?? 0) * b.blk + (w.to ?? 0) * b.to + (w.tpm ?? 0) * b.tpm
const fpHeat = (a: number, p: number) => clamp1((a - p) / Math.max(8, p * 0.4))
const isZero = (b: Box, c: { key: string; cat: CatKey | null }) => c.cat && c.cat !== 'fg' && c.cat !== 'ft' ? (b as any)[c.cat] === 0 : c.key === 'fgma' ? b.fga === 0 : c.key === 'ftma' ? b.fta === 0 : false

type TodayRow = NonNullable<SeasonView['lineup']>['rows'][number]
const GAME_MS = 2.4 * 3_600_000
/** Where a row stands tonight: a game going, one finished, one to come, or none. */
const stateOf = (r: TodayRow) => (!r.game ? 'none' : !r.game.started ? 'upcoming' : r.game.final ? 'final' : 'live')
/**
 * His projection, as much of it as the game has had time for: the whole of it once final; part way through a live
 * game, the share of a game's length since tip (Yahoo sends no clock, so this is an estimate).
 */
function paceOf(r: TodayRow, now: number): Box | null {
  if (!r.tonight) return null
  return scaleBox(r.tonight, playedShare(r, now))
}
/** The share of his game played so far: all of it once final; otherwise time since tip over a game's length. */
const playedShare = (r: TodayRow, now: number) => (stateOf(r) === 'final' ? 1
  : r.game?.played != null ? Math.max(0.05, r.game.played)
  : Math.max(0.1, Math.min(1, (now - (r.game?.tip ? Date.parse(r.game.tip) : now)) / GAME_MS)))
/** Early in a game a steal or two swings the pace a long way, so the shade deepens as the game goes on. */
const sure = (r: TodayRow, now: number) => 0.35 + 0.65 * playedShare(r, now)
const ACTIVE_SLOT = (slot: string | null) => !!slot && !['BN', 'IL', 'IL+'].includes(slot)

/**
 * A group of today's roster: slot, player and tag, the game (or the next one), his line by category, games left in
 * the week. A game going or done shows what he has done, one number a cell, shaded by how far it runs from his
 * projection (green up, red down, deeper the further); a game to come shows the projection, in italics. A game in
 * progress tints the row; a player with no game is dimmed. The group playing tonight ends with what my starters have
 * done so far (2026-10-20: the projection under each live number read as a second number, and too faint to read).
 */
function RosterGroup({ title, rows, preseason, points, total }: { title: string; rows: TodayRow[]; preseason?: boolean; points: SeasonView['league']['points']; total?: boolean }) {
  if (!rows.length) return null
  const tonight = rows.some((r) => r.game)
  const now = Date.now()
  const counted = rows.filter((r) => r.live && r.game?.started && ACTIVE_SLOT(r.slot))
  const tot = counted.length ? sumBox(counted.map((r) => r.live!)) : null
  const totPace = counted.length ? sumBox(counted.map((r) => paceOf(r, now) ?? r.live!)) : null
  return (
    <>
      <div className="nl-subh nl-grouph">{title} <span className="nl-dim">· {rows.length}</span></div>
      <div className="nl-scroll">
        <table className="nl-table nl-today">
          <colgroup>
            <col className="nl-c-slot" /><col className="nl-c-player" /><col className="nl-c-game" />
            {points && <col className="nl-c-fp" />}
            {TCOLS.map((c) => <col key={c.key} className={c.cat ? 'nl-c-cat' : 'nl-c-ma'} />)}
            <col className="nl-c-wk" />
          </colgroup>
          <thead>
            <tr>
              <th className="l">Slot</th>
              <th className="l">Player</th>
              <th className="l">{tonight ? 'Tonight' : 'Next game'}</th>
              {points && <th className="nl-catc nl-fpc" title="Fantasy points at this league's scoring">FP</th>}
              {TCOLS.map((c) => <th key={c.key} className="nl-catc">{c.label}</th>)}
              <th className="nl-wkc" title={preseason ? 'Games his team plays in week 1' : 'Games his team has left in this matchup week, today included'}>Games<div className="nl-thsub">{preseason ? 'in wk 1' : 'left in wk'}</div></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = stateOf(r)
              const real = (st === 'live' || st === 'final') && r.live ? r.live : null
              const pace = real ? paceOf(r, now) : null
              const line = real ?? r.tonight
              return (
                <tr key={r.id} className={`nl-r-${st}${ACTIVE_SLOT(r.slot) ? '' : ' nl-r-bench'}`}>
                  <td className="l nl-slotc">{r.slot ?? '—'}</td>
                  <td className="l nl-playerc">{r.name} <span className="nl-dim nl-pos">{r.positions.join('/')}</span>{r.status !== 'healthy' && <> <InjuryTag r={r} /></>}<div className="nl-line-m"><RowLine r={r} /></div></td>
                  <td className="l nl-gamec">{r.game
                    ? <>{r.game.home ? 'v' : '@'} {r.game.vs} · <GameState r={r} /></>
                    : r.next ? <span className="nl-dim">{dateWord(r.next.date)} {r.next.home ? 'v' : '@'} {r.next.vs} · proj</span> : '—'}</td>
                  {points && (
                    <td className={`nl-catc nl-fpc${real ? '' : ' nl-projv'}`} style={real && pace ? shade(fpHeat(fpOf(real, points), fpOf(pace, points)) * sure(r, now)) : undefined}>
                      {line ? (real ? <b>{fpOf(real, points).toFixed(1)}</b> : fpOf(line, points).toFixed(1)) : ''}
                    </td>
                  )}
                  {TCOLS.map((c) => (
                    <td key={c.key} className={`nl-catc${real ? (isZero(real, c) ? ' nl-zero' : '') : ' nl-projv'}`} style={real && pace && c.cat ? shade(heat(c.cat, real, pace) * sure(r, now)) : undefined}>
                      {line ? c.cell(line, !!real) : ''}
                    </td>
                  ))}
                  <td className="nl-wkc">{r.weekGames ?? ''}</td>
                </tr>
              )
            })}
            {total && tot && totPace && (
              <tr className="nl-total">
                <td className="l" colSpan={3}>Tonight so far · {counted.length} starter{counted.length === 1 ? '' : 's'}<div className="nl-line-m"><b>{lineOf(tot, true)}</b> · FG {rate(tot.fgm, tot.fga)} · FT {rate(tot.ftm, tot.fta)}</div></td>
                {points && <td className="nl-catc nl-fpc" style={shade(fpHeat(fpOf(tot, points), fpOf(totPace, points)))}><b>{fpOf(tot, points).toFixed(1)}</b></td>}
                {TCOLS.map((c) => <td key={c.key} className="nl-catc" style={c.cat ? shade(heat(c.cat, tot, totPace)) : undefined}>{c.cell(tot, true)}</td>)}
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

/**
 * Where his game stands, as Yahoo's matchup page has it: "Final (W) 106–100" in italics once over; the period and
 * clock with the score while on ("Q2 4:12 · 55–48", his team first); the tip time before. Without the scoreboard,
 * "live" or "final" from the tip time.
 */
function GameState({ r }: { r: TodayRow }) {
  const g = r.game!
  const st = stateOf(r)
  const score = g.score ? `${g.score.us}–${g.score.them}` : ''
  if (st === 'final') return <i className="nl-final">{g.status ?? 'Final'}{g.won != null ? ` (${g.won ? 'W' : 'L'})` : ''}{score ? ` ${score}` : ''}</i>
  if (st === 'live') return <><b className="nl-live">{g.status ?? 'live'}</b>{score && <span className={g.score!.us > g.score!.them ? 'nl-up' : g.score!.us < g.score!.them ? 'nl-down' : ''}> · {score}</span>}</>
  return <span className="nl-dim">{time(g.tip)} · proj</span>
}

/** On a phone, where the category columns do not fit: the line under his name. */
function RowLine({ r }: { r: TodayRow }) {
  const st = stateOf(r)
  if ((st === 'live' || st === 'final') && r.live) return <><b>{lineOf(r.live, true)}</b> · {r.live.fgm}/{r.live.fga} FG · {r.live.ftm}/{r.live.fta} FT</>
  return r.tonight ? <span className="nl-projv">proj {lineOf(r.tonight)}</span> : null
}

/** A game in one short line: 18p 5r 6a 2·3 1.2s 0.4b. A real line (whole) has no tenths. */
function lineOf(b: { pts: number; reb: number; ast: number; tpm: number; stl: number; blk: number }, whole = false): string {
  const n = (x: number) => (whole || x >= 3 ? Math.round(x).toString() : x.toFixed(1))
  return `${n(b.pts)}p ${n(b.reb)}r ${n(b.ast)}a ${n(b.tpm)}·3 ${n(b.stl)}s ${n(b.blk)}b`
}

// ── Week ──

const STATE_WORD: Record<CatRace['state'], string> = { safe: 'safe', leaning: 'leaning yours', swing: 'in play', behind: 'leaning theirs', lost: 'gone', done: 'decided' }

function fmt(cat: Cat, x: number) {
  return cat === 'fg' || cat === 'ft' ? x.toFixed(3).replace(/^0/, '') : Math.round(x).toString()
}

type WBox = SeasonView['week'] extends infer W ? W extends { players: { box: infer B }[] } ? B : never : never
const emptyBoxUI = (): WBox => ({ fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0 }) as WBox
const addBoxUI = (a: WBox, b: WBox): WBox => Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + (b as any)[k]])) as WBox
/** Yahoo's column order: MPG, FGM/A, FG%, FTM/A, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO. */
const num = (x: number) => (x >= 10 ? Math.round(x).toString() : x.toFixed(1))
const YCOLS: { key: string; label: string; cat: Cat | null; dim?: boolean; cell: (b: WBox) => string }[] = [
  { key: 'fgma', label: 'FGM/A', cat: null, dim: true, cell: (b) => `${num(b.fgm)}/${num(b.fga)}` },
  { key: 'fg', label: 'FG%', cat: 'fg', cell: (b) => boxCell(b, 'fg') },
  { key: 'ftma', label: 'FTM/A', cat: null, dim: true, cell: (b) => `${num(b.ftm)}/${num(b.fta)}` },
  { key: 'ft', label: 'FT%', cat: 'ft', cell: (b) => boxCell(b, 'ft') },
  { key: 'tpm', label: '3PTM', cat: 'tpm', cell: (b) => boxCell(b, 'tpm') },
  { key: 'pts', label: 'PTS', cat: 'pts', cell: (b) => boxCell(b, 'pts') },
  { key: 'reb', label: 'REB', cat: 'reb', cell: (b) => boxCell(b, 'reb') },
  { key: 'ast', label: 'AST', cat: 'ast', cell: (b) => boxCell(b, 'ast') },
  { key: 'stl', label: 'ST', cat: 'stl', cell: (b) => boxCell(b, 'stl') },
  { key: 'blk', label: 'BLK', cat: 'blk', cell: (b) => boxCell(b, 'blk') },
  { key: 'to', label: 'TO', cat: 'to', cell: (b) => boxCell(b, 'to') },
]

/** A week's box in one category: the percentages as made over attempted, the rest rounded. */
function boxCell(b: WBox, c: Cat): string {
  if (c === 'fg') return b.fga ? (b.fgm / b.fga).toFixed(3).replace(/^0/, '') : '—'
  if (c === 'ft') return b.fta ? (b.ftm / b.fta).toFixed(3).replace(/^0/, '') : '—'
  const x = (b as any)[c] as number
  return x >= 10 ? Math.round(x).toString() : x.toFixed(1)
}

/**
 * The week's remaining days as lineup spots: each day a bar of the league's starting spots, filled where one of my
 * players has a game and a spot, empty where nobody of mine plays. Empty spots are where an added player's game counts,
 * so the headline names the best days for that; the opponent's starters sit beside for the race in games played.
 */
function DaysLeft({ w, today }: { w: NonNullable<SeasonView['week']>; today: string }) {
  const seats = Math.max(1, ...w.days.map((d) => d.mine + d.open))
  // An add counts from tomorrow, so today is never one of the best days to add (2026-10-20: it named Tuesday at 9pm).
  const best = [...w.days].filter((d) => d.date > today && d.open >= 2).sort((a, b) => b.open - a.open).slice(0, 3).sort((a, b) => a.date.localeCompare(b.date))
  const gap = Math.round(w.startsLeft.mine - w.startsLeft.theirs)
  return (
    <>
      <p className="nl-line">
        You start <b>{Math.round(w.startsLeft.mine)}</b> games the rest of this week, {w.opponent?.name ?? 'your opponent'} <b>{Math.round(w.startsLeft.theirs)}</b>
        {gap < 0 ? ` (${-gap} fewer).` : gap > 0 ? ` (${gap} more).` : '.'}{' '}
        {best.length
          ? <>Best days to add a player: <b>{best.map((d) => day(d.date)).join(', ')}</b>, the days with the most empty spots.</>
          : w.days.some((d) => d.date > today) ? 'Your spots are nearly full every day left: an added player would mostly sit.' : 'No days left this week to add a player for.'}
      </p>
      <div className="nl-dl">
        {w.days.map((d) => (
          <div key={d.date} className="nl-dlrow">
            <span className="nl-dlday">{day(d.date)}</span>
            <span className="nl-dlbar" aria-label={`${d.mine} of ${seats} spots filled`}>
              {Array.from({ length: seats }, (_, i) => <i key={i} className={i < d.mine ? 'on' : ''} />)}
            </span>
            <span className="nl-dlnum"><b>{d.mine}</b>/{seats}</span>
            <span className="nl-dlnote">
              {d.open > 0 ? <span className={d.open >= 2 ? 'nl-dlopen' : ''}>{d.open} empty</span> : <span className="nl-dim">full</span>}
              {d.idle > 0 && <span className="nl-dim"> · {d.idle} of yours sit{d.idle === 1 ? 's' : ''} (no spot)</span>}
            </span>
            <span className={`nl-dlopp${d.theirs > d.mine ? ' ahead' : ''}`}>them {d.theirs}</span>
          </div>
        ))}
      </div>
      <p className="nl-note">Filled: your players with a game that day and a lineup spot. Empty: spots nobody of yours plays in — a player added who plays that day fills one, and his stats count.</p>
    </>
  )
}

type SoFarRow = NonNullable<NonNullable<SeasonView['week']>['soFar']>['mine'][number]
type WeekRow = { id: string; name: string; gp: number | null; gs: number; mpg: number | null; box: Box; proj: Box | null; bench: Box | null }

/** A side's so-far rows, kept to one day when one is picked: what counted, its projection, what sat on the bench. */
function soFarRows(rows: SoFarRow[], day: string): WeekRow[] {
  return rows.map((r) => {
    const ds = r.days.filter((d) => day === 'all' || d.date === day)
    const on = ds.filter((d) => d.active), off = ds.filter((d) => !d.active)
    return { id: r.id, name: r.name, gp: ds.length, gs: on.length, mpg: null, box: sumBox(on.map((d) => d.box)), proj: sumBox(on.map((d) => d.proj)), bench: off.length ? sumBox(off.map((d) => d.box)) : null }
  }).filter((r) => r.gp > 0).sort((a, b) => b.gs - a.gs || b.box.pts - a.box.pts)
}

/** Two lines side by side, category by category: who leads (green for the leader's cell, red for the other) and by how much. */
function vsHeat(cat: CatKey, a: Box, b: Box): number {
  if (cat === 'fg' || cat === 'ft') {
    const m = cat === 'fg' ? 'fgm' : 'ftm', at = cat === 'fg' ? 'fga' : 'fta'
    if (!a[at] || !b[at]) return 0
    return clamp1((a[m] / a[at] - b[m] / b[at]) / 0.06)
  }
  const x = (a[cat] - b[cat]) / Math.max(UNIT[cat] * 2, ((a[cat] + b[cat]) / 2) * 0.35)
  return clamp1(cat === 'to' ? -x : x)
}
const benchWords = (b: Box) => [b.pts ? `${Math.round(b.pts)} pts` : '', b.reb ? `${Math.round(b.reb)} reb` : '', b.ast ? `${Math.round(b.ast)} ast` : '', b.tpm ? `${Math.round(b.tpm)} 3s` : '', b.stl ? `${Math.round(b.stl)} stl` : '', b.blk ? `${Math.round(b.blk)} blk` : ''].filter(Boolean).join(', ')

/**
 * The week's players three ways: so far (what counted, game by game in active spots, each cell shaded by how far it
 * ran from his projection for those games, and the two sides' totals shaded against each other), the rest of the week
 * (expected starts and what they produce), or the whole week (both). The so-far totals are the tiles' "so far"
 * (2026-10-20: once games had started the table was still projections, and nothing showed who made up the tiles).
 */
function WeekPlayers({ v, w, side, setSide, mode, setMode, dayPick, setDayPick, swingCats, fpw }: {
  v: SeasonView; w: NonNullable<SeasonView['week']>; side: 'mine' | 'theirs'; setSide: (s: 'mine' | 'theirs') => void
  mode: 'sofar' | 'rest' | 'whole'; setMode: (m: 'sofar' | 'rest' | 'whole') => void; dayPick: string; setDayPick: (d: string) => void
  swingCats: Set<Cat>; fpw: SeasonView['league']['points']
}) {
  const sf = w.soFar
  const m = mode === 'sofar' && !sf ? 'rest' : mode
  const restOf = (rs: NonNullable<SeasonView['week']>['players']): WeekRow[] => rs.map((p) => ({ id: p.id, name: p.name, gp: null, gs: p.starts, mpg: p.mpg, box: p.box as Box, proj: null, bench: null }))
  const restRows = restOf(side === 'theirs' ? w.oppPlayers : w.players)
  const soRows = sf ? soFarRows(side === 'theirs' ? sf.theirs : sf.mine, m === 'whole' ? 'all' : dayPick) : []
  let rows: WeekRow[]
  if (m === 'sofar') rows = soRows
  else if (m === 'rest') rows = restRows
  else {
    const byId = new Map<string, WeekRow>()
    for (const r of soRows) byId.set(r.id, { ...r, proj: null })
    for (const r of restRows) {
      const o = byId.get(r.id)
      byId.set(r.id, o ? { ...o, gs: o.gs + r.gs, mpg: r.mpg, box: sumBox([o.box, r.box]) } : r)
    }
    rows = [...byId.values()].sort((a, b) => b.gs - a.gs)
  }
  const usDay = (rs: SoFarRow[]) => sumBox(soFarRows(rs, dayPick).map((r) => r.box))
  const us = sf ? usDay(sf.mine) : null, them = sf ? usDay(sf.theirs) : null
  const cats = !fpw
  const cols = YCOLS
  const real = m === 'sofar'
  const total = sumBox(rows.map((r) => r.box))
  return (
    <>
      <div className="nl-weekbar">
        <div className="nl-sidepick" role="tablist" aria-label="What the table shows">
          {sf && <button role="tab" aria-selected={m === 'sofar'} className={m === 'sofar' ? 'on' : ''} onClick={() => setMode('sofar')}>So far</button>}
          <button role="tab" aria-selected={m === 'rest'} className={m === 'rest' ? 'on' : ''} onClick={() => setMode('rest')}>Rest of week</button>
          {sf && <button role="tab" aria-selected={m === 'whole'} className={m === 'whole' ? 'on' : ''} onClick={() => setMode('whole')}>Whole week</button>}
        </div>
        {w.oppPlayers.length > 0 && (
          <div className="nl-sidepick" role="tablist" aria-label="Whose players">
            <button role="tab" aria-selected={side === 'mine'} className={side === 'mine' ? 'on' : ''} onClick={() => setSide('mine')}>Yours</button>
            <button role="tab" aria-selected={side === 'theirs'} className={side === 'theirs' ? 'on' : ''} onClick={() => setSide('theirs')}>{w.opponent?.name ?? 'Opponent'}</button>
          </div>
        )}
      </div>
      {m === 'sofar' && sf && sf.days.length > 1 && (
        <div className="nl-daychips" role="tablist" aria-label="Which day">
          {['all', ...sf.days].map((d) => <button key={d} role="tab" aria-selected={dayPick === d} className={dayPick === d ? 'on' : ''} onClick={() => setDayPick(d)}>{d === 'all' ? 'All days' : day(d)}</button>)}
        </div>
      )}
      <div className="nl-scroll">
        <table className="nl-table nl-wkp">
          <thead><tr>
            <th className="l">Player</th>
            {m === 'sofar'
              ? <><th title="Games played">GP</th><th title="Games in an active spot: the ones that counted">GS</th></>
              : <><th title={m === 'rest' ? 'Expected starts from here: his games with a lineup spot, less his chance of sitting hurt' : 'Games that counted plus expected starts from here'}>Starts</th><th title="Projected minutes a game">MPG</th></>}
            {fpw && <th title="Fantasy points at this league's scoring">FP</th>}
            {cols.map((c) => <th key={c.key} className={cats && !real && c.cat && swingCats.has(c.cat) ? 'nl-inplay' : c.dim ? 'nl-dimh' : ''} title={cats && !real && c.cat && swingCats.has(c.cat) ? 'In play this week' : undefined}>{c.label}</th>)}
          </tr></thead>
          <tbody>
            {!rows.length && <tr><td className="l nl-dim" colSpan={cols.length + 4}>{m === 'sofar' ? 'Nobody has played on this day.' : 'No games left this week.'}</td></tr>}
            {rows.map((p) => (
              <Fragment key={p.id}>
                <tr className={m === 'sofar' && p.gs === 0 ? 'nl-r-benchonly' : p.gs < 0.5 && m !== 'sofar' ? 'nl-idle' : ''}>
                  <td className="l">{p.name}</td>
                  {m === 'sofar' ? <><td>{p.gp}</td><td>{p.gs}</td></> : <><td>{p.gs.toFixed(1)}</td><td>{p.mpg != null ? p.mpg.toFixed(0) : '—'}</td></>}
                  {fpw && <td style={real && p.proj && p.gs ? shade(fpHeat(fpOf(p.box, fpw), fpOf(p.proj, fpw))) : undefined}>{real && !p.gs ? '—' : <b>{real ? fpOf(p.box, fpw).toFixed(1) : fpOf(p.box, fpw).toFixed(0)}</b>}</td>}
                  {cols.map((c) => (
                    <td key={c.key} className={`${cats && c.cat && swingCats.has(c.cat) && !real ? 'nl-inplay' : c.dim ? 'nl-dim' : ''}${real && p.gs && isZero(p.box, { key: c.key, cat: c.cat as CatKey | null }) ? ' nl-zero' : ''}`}
                      style={real && p.proj && p.gs && c.cat ? shade(heat(c.cat as CatKey, p.box, p.proj)) : undefined}>
                      {real && !p.gs ? '—' : real ? realCell(c.key, p.box) : c.cell(p.box)}
                    </td>
                  ))}
                </tr>
                {m === 'sofar' && p.bench && benchWords(p.bench) && (
                  <tr className="nl-r-benchnote"><td className="l" colSpan={cols.length + 3 + (fpw ? 1 : 0)}>On the bench {(p.gp ?? 0) - p.gs === 1 ? 'for 1 game' : `for ${(p.gp ?? 0) - p.gs} games`}: {benchWords(p.bench)}{fpw ? ` (${fpOf(p.bench, fpw).toFixed(1)} FP)` : ''} — did not count</td></tr>
                )}
              </Fragment>
            ))}
            {m === 'sofar' && us && them
              ? (['mine', 'theirs'] as const).map((who) => {
                  const a = who === 'mine' ? us : them, b = who === 'mine' ? them : us
                  return (
                    <tr key={who} className={`nl-total${who === side ? '' : ' nl-total-other'}`}>
                      <td className="l">{who === 'mine' ? 'You' : (w.opponent?.name ?? 'Them')} · counted</td><td /><td />
                      {fpw && <td style={shade(fpHeat(fpOf(a, fpw), fpOf(b, fpw)))}><b>{fpOf(a, fpw).toFixed(1)}</b></td>}
                      {cols.map((c) => <td key={c.key} style={c.cat ? shade(vsHeat(c.cat as CatKey, a, b)) : undefined}>{realCell(c.key, a)}</td>)}
                    </tr>
                  )
                })
              : rows.length > 0 && (
                <tr className="nl-total"><td className="l">{side === 'mine' ? 'Your week' : 'Their week'}</td><td>{rows.reduce((a, p) => a + p.gs, 0).toFixed(0)}</td><td />
                  {fpw && <td><b>{fpOf(total, fpw).toFixed(0)}</b></td>}
                  {cols.map((c) => <td key={c.key} className={cats && c.cat && swingCats.has(c.cat) ? 'nl-inplay' : c.dim ? 'nl-dim' : ''}>{c.cell(total)}</td>)}</tr>
              )}
          </tbody>
        </table>
      </div>
      <p className="nl-note">
        {m === 'sofar'
          ? <>What counted: each player's games in an active spot, from Yahoo's lineups day by day; games on the bench are listed under him and did not count. Each cell is shaded green where he ran ahead of his projection for those games and red where he fell short, deeper the further. The last two lines are the two sides' totals, each category shaded for whoever leads and by how much{cats ? '; they are the tiles\u2019 "so far"' : ''}.</>
          : m === 'rest'
            ? <>Expected starts from here times his line, seated night by night{fpw ? '; FP is that at this league\u2019s scoring, the sum of which plus the points so far is the projected week above' : ''}.{cats && <> Highlighted columns are this week's categories in play (35–65%): the players strongest in them are the ones not to bench, and what a stream should bring.</>}</>
            : <>What counted so far plus what is expected from here: the whole week, player by player.</>}
      </p>
    </>
  )
}

/** A real week's cell: whole counts and made/attempted, the percentages to three places. */
function realCell(key: string, b: Box): string {
  if (key === 'fgma') return `${Math.round(b.fgm)}/${Math.round(b.fga)}`
  if (key === 'ftma') return `${Math.round(b.ftm)}/${Math.round(b.fta)}`
  if (key === 'fg') return rate(b.fgm, b.fga)
  if (key === 'ft') return rate(b.ftm, b.fta)
  return Math.round((b as any)[key]).toString()
}

function Week({ v }: { v: SeasonView }) {
  const w = v.week
  // Whose players the table shows: mine by default, the opponent's on a tap (one table, not two).
  const [side, setSide] = useState<'mine' | 'theirs'>('mine')
  // What the table shows: what has counted so far (once anyone has played), what is still to come, or both.
  const [mode, setMode] = useState<'sofar' | 'rest' | 'whole'>(() => (v.week?.soFar ? 'sofar' : 'rest'))
  const [dayPick, setDayPick] = useState<string>('all')
  if (!w) return <div className="ckempty">No matchup this week.</div>
  const rows = side === 'theirs' && w.oppPlayers.length ? w.oppPlayers : w.players
  // A points league's weights: the table leads with each player's fantasy points (it showed only for categories).
  const fpw = v.league.scoring === 'points' ? v.league.points : null
  const swing = w.odds?.races.filter((r) => r.state === 'swing').map((r) => LABEL[r.cat]) ?? []
  const swingCats = new Set<Cat>(w.odds?.races.filter((r) => r.state === 'swing').map((r) => r.cat) ?? [])
  return (
    <>
      <div className="nl-score">
        <div>
          <div className="nl-vs">Week {w.week}{w.playoffs ? ' · playoffs' : ''} · vs {w.opponent?.name ?? '—'}</div>
          {w.odds && (
            <div className="nl-big">{w.score.mine ?? 0}–{w.score.theirs ?? 0}
              <span className="nl-sub"> now · {w.odds.expected.toFixed(1)} of 9 categories expected this week · {pct(w.odds.win)} chance to win the matchup</span></div>
          )}
          {w.points && (
            <div className="nl-big">{w.points.mineNow.toFixed(0)}–{w.points.theirsNow.toFixed(0)}
              <span className="nl-sub"> now · {w.points.mine.toFixed(0)}–{w.points.theirs.toFixed(0)} projected · win {pct(w.points.win)}</span></div>
          )}
        </div>
      </div>
      {w.odds && (() => {
        const by = (st: string[]) => w.odds!.races.filter((r) => st.includes(r.state)).map((r) => LABEL[r.cat])
        const fav = by(['safe', 'leaning']), against = by(['behind', 'lost']), play = by(['swing'])
        return (
          <p className="nl-preview">
            {fav.length > 0 && <>Favored in <b>{fav.join(', ')}</b>. </>}
            {against.length > 0 && <>Behind in <b>{against.join(', ')}</b>. </>}
            {play.length > 0 ? <>In play: <b className="nl-amber">{play.join(', ')}</b> — that is where a start or a stream decides the week.</> : 'Nothing is close: the week is mostly decided by who plays.'}
          </p>
        )
      })()}
      <p className="nl-line">
        {w.startsLeft.mine.toFixed(0)} starts left for you, {w.startsLeft.theirs.toFixed(0)} for them.
        {w.idleGames >= 1 && ` ${w.idleGames.toFixed(0)} of your players' games fall on days with no seat for them.`}
        {swing.length > 0 && ` In play: ${swing.join(', ')}.`}
      </p>
      {w.odds && <div className="nl-subh">Each category, you vs {w.opponent?.name ?? 'them'}: so far · your chance to win it · where it ends (projected)</div>}
      {w.odds && (
        <div className="nl-cats">
          {w.odds.races.map((r) => (
            <div key={r.cat} className={`nl-cat ${r.state}`} title={STATE_WORD[r.state]}>
              <div className="nl-catk">{LABEL[r.cat]}</div>
              <div className="nl-catv" title="The week so far: you vs them">{fmt(r.cat, r.mineNow)}<span> vs {fmt(r.cat, r.theirsNow)}</span></div>
              <div className="nl-catp">{pct(r.win + r.tie / 2)}</div>
              <div className="nl-catf" title="Where the week is projected to end: you vs them">ends {fmt(r.cat, r.mine)} vs {fmt(r.cat, r.theirs)}</div>
            </div>
          ))}
        </div>
      )}
      {w.players.length > 0 && (
        <Section title="Players this week" hint={mode === 'sofar' ? 'what has counted, player by player' : mode === 'rest' ? 'expected starts from here and what they produce' : 'what has counted plus what is expected from here'}>
          <WeekPlayers v={v} w={w} side={side} setSide={setSide} mode={mode} setMode={setMode} dayPick={dayPick} setDayPick={setDayPick} swingCats={swingCats} fpw={fpw} />
        </Section>
      )}
      <Section title="Days left" hint="your lineup spots, day by day">
        <DaysLeft w={w} today={v.today} />
      </Section>
      {w.odds
        ? <p className="nl-note">Each category is the week so far plus what both lineups are expected to do from here, seated day by day. A race at 35–65% is in play: that is where a stream helps.</p>
        : <p className="nl-note">The projected week is the points so far plus what both lineups are expected to score from here, seated day by day.</p>}
    </>
  )
}

// ── Adds ──

function Adds({ v }: { v: SeasonView }) {
  const b = v.budget
  const streams = v.pickups.filter((p) => p.kind === 'stream')
  const ups = v.pickups.filter((p) => p.kind === 'upgrade')
  const stashes = v.pickups.filter((p) => p.kind === 'stash')
  const cats = v.league.scoring === 'categories'
  return (
    <>
      {v.startsOn && <div className="nl-pre">The season starts {dateWord(v.startsOn)}. Season upgrades and stashes can be made now; streams appear once games begin.</div>}
      {b && (
        <div className="nl-budget">
          {b.week && <div><b>{Math.max(0, b.week.max - b.week.used)}</b> of {b.week.max} left this week</div>}
          {b.season && <div><b>{Math.max(0, b.season.max - b.season.used)}</b> of {b.season.max} left this season</div>}
          <div className="nl-dim">{b.note}</div>
        </div>
      )}
      {v.addPlan && v.addPlan.steps.length > 0 && (
        <Section title="This week's plan" hint={`${v.addPlan.left} add${v.addPlan.left === 1 ? '' : 's'} left${v.addPlan.reserve ? `, ${v.addPlan.reserve} kept for an injury` : ''}`}>
          <ol className="nl-plan">
            {v.addPlan.steps.map((st, i) => (
              <li key={i}><b>Add {st.add}</b>{st.drop && <>, drop {st.drop}</>} <span className="nl-dim">— {st.when}</span>
                <div className="nl-dim">{st.why}{st.season != null && <> · rest of season <SeasonWins w={st.season} /></>}{st.week && <> · <WeekWin before={st.week.before} after={st.week.after} prefix="this week " /></>}</div></li>
            ))}
          </ol>
        </Section>
      )}
      <Section title="For the rest of the season" hint="more matchups won over the weeks left, against each week’s real opponent; most first">
        {!ups.length && <div className="nl-none">Nobody on the wire beats your roster by enough to spend an add.</div>}
        {ups.map((p) => <PickupRow key={p.add} p={p} cats={cats} />)}
      </Section>
      {v.pairs?.length > 0 && (
        <Section title="Two moves together" hint="worth more than any one move by itself">
          {v.pairs.map((pr, i) => (
            <div key={i} className="nl-pick">
              <div className="nl-pickh"><span className="nl-kind upgrade">pair</span> <b>Rest of season: <SeasonWins w={pr.seasonWins} /></b> · <WeekWin before={pr.winBefore} after={pr.winAfter} prefix="this week: win " /></div>
              {pr.moves.map((m) => (
                <div key={m.add} className="nl-pickd">
                  <b>Add {m.name}</b>, drop {m.dropName} <span className="nl-dim">(<span className={effect(m.seasonWins, 0.03)}>{wins(m.seasonWins)}</span> alone{m.waiver ? ' · waivers' : ''})</span>
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}
      {stashes.length > 0 && (
        <Section title="Injured stashes" hint="out now, worth an IL seat">
          {stashes.map((p) => <PickupRow key={p.add} p={p} cats={cats} />)}
        </Section>
      )}
      <Section title="Streams for this week" hint={b ? `${b.forStreams} to spend at your pace` : undefined}>
        {!streams.length && <div className="nl-none">{v.startsOn ? `No games until ${dateWord(v.startsOn)}: streams start then.` : 'No stream moves this week by enough to spend an add.'}</div>}
        {streams.map((p, i) => <PickupRow key={p.add} p={p} cats={cats} over={b ? i >= b.forStreams : false} />)}
      </Section>
      {v.punts.length > 0 && <p className="nl-note">Your roster is not competing in {v.punts.map((c) => LABEL[c]).join(', ')}, so season value leaves {v.punts.length === 1 ? 'it' : 'them'} out. A stream counts every category: any category won this week counts.</p>}
    </>
  )
}

/**
 * What a move does, coloured by effect (2026-10-21: the week's win change read in white, like everything else):
 * green where it helps, a softer red where it hurts, yellow where it changes nothing worth the name.
 */
const effect = (d: number, eps: number) => (d > eps ? 'nl-help' : d < -eps ? 'nl-hurt' : 'nl-flat')
/** This week's chance of winning, before and after, coloured by the change. */
function WeekWin({ before, after, extra, prefix = 'This week: win ' }: { before: number; after: number; extra?: string; prefix?: string }) {
  const d = after - before
  return <span className={effect(d, 0.01)}>{prefix}{pct(before)} → {pct(after)}{extra ? ` ${extra}` : ''}{d < -0.02 ? ' — costs this week' : Math.abs(d) <= 0.01 ? ' — no change this week' : ''}</span>
}
/** Matchups won over the season, coloured by sign. */
const SeasonWins = ({ w }: { w: number }) => <b className={effect(w, 0.03)}>{wins(w)}</b>

/**
 * One pickup: who to add and drop, whether he is a free agent (now) or on waivers (a claim, a day), what it does for
 * the rest of the season and, separately, for this week, which can disagree; the other players he could replace.
 */
function PickupRow({ p, cats, over }: { p: SeasonView['pickups'][number]; cats: boolean; over?: boolean }) {
  const wk = (g: number) => (cats ? `${g >= 0 ? '+' : ''}${g.toFixed(2)} cats` : `${g >= 0 ? '+' : ''}${g.toFixed(0)} pts`)
  return (
    <div className={`nl-pick${over ? ' over' : ''}`}>
      <div className="nl-pickh">
        <span className={`nl-kind ${p.kind}`}>{p.kind}</span>
        <b>Add {p.name}</b> <span className="nl-dim">{p.team} · {p.positions.join('/')}</span>
        <span className={`nl-src ${p.waiver ? 'waiver' : 'free'}`} title={p.waiver ? 'On waivers: put in a claim; it clears after the waiver period' : 'A free agent: add him now'}>{p.waiver ? 'waivers · claim' : 'free agent · add now'}</span>
      </div>
      <div className="nl-pickd">
        {p.dropName && <><b>Drop {p.dropName}</b> · </>}{p.why}
      </div>
      <div className="nl-pickd nl-dim">
        {p.kind !== 'stream' && <SeasonGain p={p} />}
        {p.kind !== 'stream' && ' · '}
        <WeekWin before={p.winBefore} after={p.winAfter} extra={`(${wk(p.weekGain)})`} />
        {over && <span> · beyond your pace</span>}
      </div>
      {cats && p.seasonCats.length > 0 && p.kind !== 'stream' && (
        <div className="nl-pickd nl-why2" title={`Per game, against ${p.dropName ?? 'the player dropped'}, in the categories you are competing in`}>
          Season, vs {p.dropName}: {p.seasonCats.map((c) => <span key={c.cat} className={`nl-catchip ${c.diff > 0 ? 'up' : 'down'}`}>{c.diff > 0 ? '+' : '−'}{LABEL[c.cat]}</span>)}
        </div>
      )}
      {cats && p.weekCats.length > 0 && (
        <div className="nl-pickd nl-why2" title="This week's chance to win each category, before and after the move">
          This week: {p.weekCats.map((c) => <span key={c.cat} className={`nl-catchip ${c.after > c.before ? 'up' : 'down'}`}>{LABEL[c.cat]} {pct(c.before)}→{pct(c.after)}</span>)}
        </div>
      )}
      {p.playDays.length > 0 && (
        <div className="nl-pickd nl-why2" title="The days he plays this week once added. ✓: you have an empty lineup spot he can fill that day, so his game counts without benching anyone">
          Plays: {p.playDays.map((d) => <span key={d.date} className={`nl-catchip ${d.open ? 'up' : 'flat'}`}>{day(d.date)}{d.open ? ' ✓' : ''}</span>)}
          <span className="nl-dim"> {p.playDays.filter((d) => d.open).length} of {p.playDays.length} games into empty spots</span>
        </div>
      )}
      {p.steps && <div className="nl-steps">{p.steps}</div>}
      {p.alternatives.length > 0 && (
        <div className="nl-pickd nl-dim">Or drop: {p.alternatives.map((a, i) => <span key={a.drop}>{i ? ' · ' : ''}{a.dropName} <span title="this week's win chance after the move, and matchups won over the season">(week <span className={effect(a.winAfter - p.winBefore, 0.01)}>{pct(a.winAfter)}</span>, season {a.seasonWins != null ? <span className={effect(a.seasonWins, 0.03)}>{wins(a.seasonWins)}</span> : `+${Math.round(a.seasonGain)}`})</span></span>)}</div>
      )}
    </div>
  )
}

const wins = (w: number) => `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(2)} wins`

/**
 * What a season move does for the rest of the regular season, in matchups won: every week's lineups against that
 * week's opponent, each player at his own rate of games played. Before the league's schedule is read, this week's
 * opponent stands in for every week, and the card says so.
 */
function SeasonGain({ p }: { p: SeasonView['pickups'][number] }) {
  if (p.seasonWins == null) {
    return <span title="His value over the games he has left, less the dropped player's: categories in play, summed per game">Season: +{Math.round(p.seasonGain)} value</span>
  }
  const how = p.scheduled
    ? `Every week left in the regular season (${p.seasonWeeks}), each against that week's opponent, with every player at his own rate of games played: matchups expected won, before and after the move. A pickup who fills spots left empty counts in full; one who would mostly sit barely counts.`
    : `The ${p.seasonWeeks} regular-season weeks left, with this week's opponent standing in for every week until the league's schedule is read.`
  return <span title={how}>Rest of season: <SeasonWins w={p.seasonWins} />{p.scheduled ? '' : ' (vs this week’s opponent)'}</span>
}

type ViewRow = { id: string; name: string; team: string | null; stats: Record<string, number>; scope: Record<string, 'all' | 'league'>; min: number | null; gp: number | null }
type PoolRow = { id: string; name: string; team: string; positions: string[]; min: number | null; gp: number; baseMin: number | null; baseGp: number }

/** For matching names as typed: no accents, no case, no punctuation (Dončić is doncic). */
const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '')

/**
 * Your view of players in this league: the minutes or games you expect instead of the projection's (a rotation call,
 * a role you doubt, a camp injury). Minutes carry every stat you have not set at the same per-minute rate; games are
 * taken as given. Pickups, the week and the power table read them; so does the draft. A player is picked from the
 * list as you type, never typed free (2026-10-19: asked for), and his current minutes and games fill in as the
 * baseline to adjust from.
 */
function YourView({ leagueId, label, onChange }: { leagueId: string; label: string; onChange: () => void }) {
  const [rows, setRows] = useState<ViewRow[] | null>(null)
  const [pool, setPool] = useState<PoolRow[]>([])
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<PoolRow | null>(null)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [min, setMin] = useState('')
  const [gp, setGp] = useState('')
  // Minutes and games are the same in every league, so that is where they go unless you say otherwise.
  const [justHere, setJustHere] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    fetch(`/api/nba/draft/${leagueId}/adjust`).then((r) => (r.ok ? r.json() : null)).then((x) => { if (x) { setRows(x.players); setPool(x.pool ?? []) } }).catch(() => {})
  }, [leagueId])
  useEffect(load, [load])
  const q = fold(query.trim())
  // Each word typed starts a word of the name, in any order ("cam joh", "johnson cam"); or the name contains it whole.
  const words = q.split(/\s+/).filter(Boolean)
  const fits = (name: string) => { const n = fold(name), parts = n.split(/\s+/); return n.includes(q) || words.every((w) => parts.some((x) => x.startsWith(w))) }
  const matches = q.length < 2 || picked ? [] : pool
    .filter((p) => fits(p.name))
    .sort((a, b) => Number(fold(b.name).startsWith(q)) - Number(fold(a.name).startsWith(q)) || (b.min ?? 0) - (a.min ?? 0))
    .slice(0, 8)
  const pick = (p: PoolRow) => {
    setPicked(p); setQuery(p.name); setOpen(false); setErr(null)
    setMin(p.min != null ? String(p.min) : ''); setGp(String(p.gp))
    // Set for this league only before: keep it that way unless changed.
    const row = rows?.find((r) => r.id === p.id)
    setJustHere(!!row && ['min', 'gp'].some((k) => row.scope?.[k] === 'league'))
  }
  const save = async (playerId: string, stats: Record<string, number | null>, scope: 'all' | 'league') => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/nba/draft/${leagueId}/adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId, stats, merge: true, scope }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      load(); onChange()
      return true
    } catch (e) { setErr((e as Error).message); return false } finally { setBusy(false) }
  }
  const submit = async () => {
    if (!picked) { setErr('Pick a player from the list'); return }
    const m = Number(min), g = Number(gp)
    if (!(m > 0 && m <= 48) || !(g > 0 && g <= 82)) { setErr('Minutes 1–48 and games 1–82'); return }
    // Only what differs from the projection is kept as yours; back to the projection clears it.
    const stats: Record<string, number | null> = {
      min: picked.baseMin != null && Math.abs(m - picked.baseMin) < 0.05 ? null : m,
      gp: g === picked.baseGp ? null : g,
    }
    if (await save(picked.id, stats, justHere ? 'league' : 'all')) { setPicked(null); setQuery(''); setMin(''); setGp(''); setJustHere(false) }
  }
  const edit = (r: ViewRow) => { const p = pool.find((x) => x.id === r.id); if (p) pick(p) }
  const onKey = (e: React.KeyboardEvent) => {
    if (!matches.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(matches[hi] ?? matches[0]) }
    else if (e.key === 'Escape') setOpen(false)
  }
  const shown = (rows ?? []).filter((r) => r.stats.min != null || r.stats.gp != null)
  const rest = (rows ?? []).length - shown.length
  return (
    <Section title="Your view of players" hint="minutes and games you expect; pickups and the week use them">
      {!shown.length && <div className="nl-none">None set. The projections stand for everyone.</div>}
      {shown.map((r) => (
        <div key={r.id} className="nl-yv-row">
          <button className="nl-link nl-yv-name" onClick={() => edit(r)} title="Change">{r.name}</button> <span className="nl-dim">{r.team}</span>
          {(['min', 'gp'] as const).filter((k) => r.stats[k] != null).map((k) => (
            <span key={k}> · {r.stats[k]} {k === 'min' ? 'min' : 'games'} <span className="nl-dim">(projection {(k === 'min' ? r.min : r.gp)?.toFixed(0) ?? '—'}{r.scope?.[k] === 'league' ? `, ${label} only` : ', all leagues'})</span> <button className="nl-link" disabled={busy} onClick={() => save(r.id, { [k]: null }, r.scope?.[k] === 'league' ? 'league' : 'all')}>clear</button></span>
          ))}
        </div>
      ))}
      {rest > 0 && <div className="nl-none">{rest} more with stats set in the draft room.</div>}
      <div className="nl-yv-form">
        <div className="nl-yv-pick">
          <input aria-label="Player" placeholder="Player" value={query} autoComplete="off" role="combobox" aria-expanded={open && matches.length > 0}
            onChange={(e) => { setQuery(e.target.value); setPicked(null); setOpen(true); setHi(0) }} onKeyDown={onKey} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
          {open && matches.length > 0 && (
            <ul className="nl-yv-list" role="listbox">
              {matches.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(p) }} onMouseEnter={() => setHi(i)}>
                  <b>{p.name}</b> <span className="nl-dim">{p.team} · {p.positions.join('/')} · {p.min?.toFixed(0) ?? '—'} min · {p.gp} g</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="nl-yv-num"><span>Minutes</span><input aria-label="Minutes a game" inputMode="decimal" value={min} disabled={!picked} onChange={(e) => setMin(e.target.value)} /></label>
        <label className="nl-yv-num"><span>Games</span><input aria-label="Games" inputMode="numeric" value={gp} disabled={!picked} onChange={(e) => setGp(e.target.value)} /></label>
        <div className="nl-yv-act">
          <button className="nl-yv-save" disabled={busy || !picked} onClick={submit}>Set</button>
          <label className="nl-yv-here"><input id="yv-just-here" type="checkbox" checked={justHere} onChange={(e) => setJustHere(e.target.checked)} /> Just {label}</label>
        </div>
      </div>
      {picked && <div className="nl-none">Projection: {picked.baseMin?.toFixed(1) ?? '—'} minutes, {picked.baseGp} games.{(picked.min !== picked.baseMin || picked.gp !== picked.baseGp) ? ' The boxes show yours.' : ''} Back to the projection clears yours. {justHere ? `Sets ${label} only.` : 'Sets all your leagues.'}</div>}
      {err && <div className="nl-warn">{err}</div>}
    </Section>
  )
}

const dateWord = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

// ── News ──

const WHOSE: Record<string, string> = { mine: 'Your players', opponent: 'This week’s opponent', free: 'Free agents', other: 'Elsewhere' }

/**
 * News: first where my players stand now (every one with a designation, the reason and a way to the news), then what
 * changed in the last few days, grouped by whose player it is: mine, this week's opponent's, free agents, the rest.
 */
function News({ v }: { v: SeasonView }) {
  const flagged = (v.lineup?.rows ?? []).filter((r) => r.status !== 'healthy')
  const groups = ['mine', 'opponent', 'free', 'other'].map((w) => [w, v.news.filter((n) => n.whose === w)] as const).filter(([, xs]) => xs.length)
  return (
    <>
      <Section title="Your players now" hint={flagged.length ? `${flagged.length} with a designation` : 'all available'}>
        {!flagged.length && <div className="nl-none">Nobody on your roster carries an injury designation.</div>}
        {flagged.map((r) => (
          <div key={r.id} className="nl-news worse">
            <div className="nl-newsh">{r.name} <InjuryTag r={r} /></div>
            <div className="nl-dim">{r.note ?? `Listed ${r.status}; no reason published.`}{r.next ? ` · next game ${dateWord(r.next.date)}` : r.game ? ' · plays today' : ''}{' · '}
              <a href={`https://www.google.com/search?q=${encodeURIComponent(`${r.name} injury news`)}&tbm=nws`} target="_blank" rel="noreferrer">news ›</a></div>
          </div>
        ))}
      </Section>
      {!groups.length && <p className="nl-note">No changes in the last few days. News lists designation changes as they happen, minutes trends once games are played, and openings when a rotation player is out.</p>}
      {groups.map(([w, xs]) => (
        <Section key={w} title={`${WHOSE[w]}: what changed`}>
          {xs.map((n) => (
            <div key={n.key} className={`nl-news ${n.kind}`}>
              <div className="nl-newsh">{n.headline}</div>
              <div className="nl-dim">{n.detail}{n.at ? ` · ${ago(n.at)}` : ''}</div>
            </div>
          ))}
        </Section>
      ))}
    </>
  )
}

// ── Season ──

function Season({ v, onChange }: { v: SeasonView; onChange: () => void }) {
  const [exp, setExp] = useState<{ name: string; leagues: { label: string; starting: boolean }[]; status: string }[] | null>(null)
  useEffect(() => { fetch('/api/nba/season/exposure').then((r) => r.json()).then(setExp).catch(() => {}) }, [])
  const cats = v.league.scoring === 'categories'
  const ap = v.allPlay
  const po = v.playoffs
  const CAT_ORDER: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
  return (
    <>
      <a className="nl-room" href={`/nba/draft/${v.league.id}`}><span className="nl-roomk">Draft</span><span>How the draft came out, and the room</span><span className="ckchev">›</span></a>
      <YourView leagueId={v.league.id} label={v.league.label} onChange={onChange} />
      {v.catPlan && (
        <Section title="Category plan" hint="against this league's rosters">
          <p className="nl-line">
            {v.catPlan.strong.length > 0 && <>Winning: <b className="nl-green">{v.catPlan.strong.map((c) => LABEL[c]).join(', ')}</b>. </>}
            {v.catPlan.lean.length > 0 && <>Leaning: <b>{v.catPlan.lean.map((c) => LABEL[c]).join(', ')}</b>. </>}
            {v.catPlan.swing.length > 0 && <>In play: <b className="nl-amber">{v.catPlan.swing.map((c) => LABEL[c]).join(', ')}</b>. </>}
            {v.catPlan.givenUp.length > 0 && <>Given up: <span className="nl-dim">{v.catPlan.givenUp.map((c) => LABEL[c]).join(', ')}</span>.</>}
          </p>
          {v.catPlan.target && (
            <>
              <p className="nl-line">
                {v.catPlan.strong.length >= 5 ? 'A 6–3 week needs a sixth category won most weeks' : 'A 5–4 week needs five categories won most weeks'}: the closest is <b>{LABEL[v.catPlan.target]}</b>.
                {v.catPlan.targets.length ? ' Free agents who would push it without costing what you win:' : ' Nobody on the wire pushes it without costing what you win.'}
              </p>
              {v.catPlan.targets.length > 0 && (
                <div className="nl-chips">{v.catPlan.targets.map((t) => (
                  <span key={t.id} className="nl-chip">{t.name} <span className="nl-dim">{t.team} · {t.positions.join('/')}{t.waiver ? ' · waivers' : ''}</span> <b>+{LABEL[v.catPlan!.target!]}</b>{t.costs.length > 0 && <span className="nl-dim"> −{t.costs.map((c) => LABEL[c]).join(', −')}</span>}</span>
                ))}</div>
              )}
            </>
          )}
        </Section>
      )}
      <Section title="Power" hint={cats ? "categories a week against this league's average roster" : "chance of beating this league's average roster"}>
        <table className="nl-table">
          <thead><tr><th>#</th><th className="l">Team</th><th>{cats ? 'Cats' : 'Win'}</th>{cats && CAT_ORDER.map((c) => <th key={c} className="nl-edgeh">{LABEL[c]}</th>)}</tr></thead>
          <tbody>
            {v.power.map((r) => (
              <tr key={r.teamId} className={r.mine ? 'nl-mine' : ''}>
                <td>{r.rank}</td>
                <td className="l">{r.name} <span className="nl-dim">{r.manager}</span></td>
                <td>{cats ? r.score.toFixed(2) : pct(r.score)}</td>
                {cats && CAT_ORDER.map((c) => {
                  const e = r.edges?.[c] ?? 0.5
                  return <td key={c} className="nl-edge" style={{ background: `color-mix(in srgb, ${e >= 0.5 ? 'var(--green)' : 'var(--red)'} ${Math.round(Math.abs(e - 0.5) * 140)}%, transparent)` }}>{Math.round(e * 100)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="nl-note">From each roster's typical week as it stands, injuries and games left included — the same yardstick the trade ideas use.</p>
      </Section>

      <Section title="Luck" hint="all-play: every team, every week">
        {!ap ? <div className="nl-none">No finished weeks yet.</div> : (
          <p className="nl-line">
            You are {ap.record.w}-{ap.record.l}{ap.record.t ? `-${ap.record.t}` : ''}. Against every team every week you would have won {pct(ap.allPlay)},
            {' '}{Math.abs(ap.luck) < 0.05 ? 'about what your record says.' : ap.luck > 0 ? `so the schedule has been kind: ${Math.round(ap.luck * ap.weeks)} more win${Math.round(ap.luck * ap.weeks) === 1 ? '' : 's'} than your play earned.` : `so the schedule has cost you about ${Math.round(-ap.luck * ap.weeks)} win${Math.round(-ap.luck * ap.weeks) === 1 ? '' : 's'}.`}
          </p>
        )}
      </Section>

      <Section title="Playoff weeks" hint={po ? `weeks ${po.weeks.join(', ')}` : undefined}>
        {!po ? <div className="nl-none">No playoff weeks set.</div> : (
          <>
            <p className="nl-line">
              Your roster plays {po.total} games in them — {ordinal(po.rank)} in the league (average {po.leagueAverage.toFixed(0)}).
              {po.tradeDeadline && po.daysToDeadline != null && po.daysToDeadline >= 0 && ` Trade deadline ${new Date(po.tradeDeadline + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${po.daysToDeadline} days away.`}
            </p>
            <div className="nl-chips">{po.mine.map((m) => <span key={m.id} className="nl-chip">{m.name} <b>{m.games}</b></span>)}</div>
            {po.targets.length > 0 && <>
              <div className="nl-subh">Free agents with more games than most</div>
              <div className="nl-chips">{po.targets.map((t) => <span key={t.id} className="nl-chip">{t.name} <span className="nl-dim">{t.team}</span> <b>{t.games}</b></span>)}</div>
            </>}
          </>
        )}
      </Section>

      <Section title="Trade ideas" hint="good for you, not bad for them">
        {!v.trades.length && <div className="nl-none">{po?.daysToDeadline != null && po.daysToDeadline < 0 ? 'The trade deadline has passed.' : 'Nothing that helps you without hurting them.'}</div>}
        {v.trades.map((t, i) => (
          <div key={i} className="nl-trade">
            <div><span className="nl-dim">{t.teamName} ({t.manager}):</span> give <b>{t.give.map((g) => g.name).join(' + ')}</b>, get <b>{t.get.map((g) => g.name).join(' + ')}</b></div>
            <div className="nl-dim">{t.why}</div>
          </div>
        ))}
      </Section>

      {exp && exp.length > 0 && (
        <Section title="In both leagues" hint="one injury, two lineups">
          <div className="nl-chips">{exp.map((e) => <span key={e.name} className={`nl-chip${e.status !== 'healthy' ? ' hurt' : ''}`}>{e.name}{e.status !== 'healthy' && <span className={`nl-stat ${e.status}`}>{e.status}</span>}</span>)}</div>
        </Section>
      )}
    </>
  )
}
