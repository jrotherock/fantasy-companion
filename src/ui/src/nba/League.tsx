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
          {tab === 'Season' && <Season v={v} />}
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
  picks: { overall: number; round: number; players: { id: string; name: string; team: string | null; positions: string[]; rank: number; adp: number; chance: number; simMark: { kind: 'up' | 'lean' | 'down'; gap: number } | null }[] }[]
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
  useEffect(() => {
    fetch(`/api/nba/takeby/${leagueId}${slot ? `?slot=${slot}` : ''}`).then((r) => r.json()).then((x) => { if (x?.picks) setTb(x) }).catch(() => {})
  }, [leagueId, slot])
  const choose = (n: number) => { setSlot(n); try { localStorage.setItem(key, String(n)) } catch { /* private window */ } }
  if (!tb) return null
  const pc = (x: number) => `${Math.round(x * 100)}%`
  return (
    <Section title="Where your picks land" hint="by value, among those likely still there">
      <div className="nl-slots">
        <span className="nl-dim">Your slot</span>
        {Array.from({ length: tb.teams }, (_, i) => i + 1).map((n) => (
          <button key={n} className={`nl-slot ${n === tb.slot ? 'on' : ''}`} onClick={() => choose(n)}>{n}</button>
        ))}
        {tb.knownSlot != null && tb.knownSlot !== tb.slot && <button className="nl-link" onClick={() => choose(tb.knownSlot!)}>yours is {tb.knownSlot}</button>}
      </div>
      {tb.gone.length > 0 && <p className="nl-note">Likely gone before your first pick: {tb.gone.map((g) => g.name).join(', ')}.</p>}
      {tb.picks.map((g, i) => (
        <div key={g.overall} className="nl-takeby">
          <div className="nl-takebyh">Your pick {i + 1} <span className="nl-dim">· round {g.round}, #{g.overall}</span></div>
          {g.players.length === 0 ? <div className="nl-dim">—</div> : (
            <div className="nl-takebylist">{g.players.map((p) => (
              <span key={p.id}><b>{p.name}</b> <span className="nl-dim">#{p.rank}{p.simMark ? ` ${p.simMark.kind === 'down' ? '▼' : p.simMark.kind === 'up' ? '▲' : '△'}` : ''} · ADP {Math.round(p.adp)} · {pc(p.chance)}</span></span>
            ))}</div>
          )}
        </div>
      ))}
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
  const rows = [...l.rows].sort((a, b) => order(a.slot) - order(b.slot))
  return (
    <>
      <div className={`nl-verdict ${l.ok ? 'ok' : 'fix'}`}>
        {l.ok
          ? 'Lineup is right for today'
          : `${l.moves.length} change${l.moves.length === 1 ? '' : 's'} to make${first ? ` — first by ${time(first)}` : ''}`}
        {l.lostStarts > 0 && <span className="nl-sub"> · {l.lostStarts} start{l.lostStarts === 1 ? '' : 's'} lost as it stands</span>}
      </div>
      {l.moves.length > 0 && (
        <ul className="nl-moves">
          {l.moves.map((m) => (
            <li key={m.start}>
              <b>Start {name(m.start)}</b>{m.bench && <> for <b>{name(m.bench)}</b></>}
              <span className="nl-why">{m.why}{m.by ? ` · by ${time(m.by)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <table className="nl-table nl-today">
        <thead><tr><th className="l nl-slotc">Slot</th><th className="l">Player</th><th className="l nl-gamec">{l.rows.some((r) => r.game) ? 'Today' : 'Next game'}</th><th className="nl-wkc" title="Games left in this matchup week">Wk</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr className={!r.game ? 'nl-idle' : ''}>
                <td className="l nl-slot">{r.slot ?? '—'}</td>
                <td className="l">{r.name} <span className="nl-dim nl-pos">{r.positions.join('/')}</span>
                  {r.status !== 'healthy' && <InjuryTag r={r} />}</td>
                <td className="l nl-dim nl-gamec">{r.game
                  ? `${r.game.home ? 'v' : '@'} ${r.game.vs} ${r.game.started ? '· under way' : time(r.game.tip)}`
                  : r.next ? `${dateWord(r.next.date)} ${r.next.home ? 'v' : '@'} ${r.next.vs}` : '—'}</td>
                <td className="nl-wkc">{r.weekGames ?? ''}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="nl-note">Yahoo locks each player at his game's tip. "Wk" is his games left in this matchup week: a bench player with more games than a starter is worth the seat, and a short week is where a stream helps. A tag's card has the chance he plays.</p>
    </>
  )
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
function DaysLeft({ w }: { w: NonNullable<SeasonView['week']> }) {
  const seats = Math.max(1, ...w.days.map((d) => d.mine + d.open))
  const best = [...w.days].filter((d) => d.open >= 2).sort((a, b) => b.open - a.open).slice(0, 3).sort((a, b) => a.date.localeCompare(b.date))
  const gap = Math.round(w.startsLeft.mine - w.startsLeft.theirs)
  return (
    <>
      <p className="nl-line">
        You start <b>{Math.round(w.startsLeft.mine)}</b> games the rest of this week, {w.opponent?.name ?? 'your opponent'} <b>{Math.round(w.startsLeft.theirs)}</b>
        {gap < 0 ? ` (${-gap} fewer).` : gap > 0 ? ` (${gap} more).` : '.'}{' '}
        {best.length
          ? <>Best days to add a player: <b>{best.map((d) => day(d.date)).join(', ')}</b>, the days with the most empty spots.</>
          : 'Your spots are nearly full every day: an added player would mostly sit.'}
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

function Week({ v }: { v: SeasonView }) {
  const w = v.week
  if (!w) return <div className="ckempty">No matchup this week.</div>
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
      <p className="nl-line">
        {w.startsLeft.mine.toFixed(0)} starts left for you, {w.startsLeft.theirs.toFixed(0)} for them.
        {w.idleGames >= 1 && ` ${w.idleGames.toFixed(0)} of your players' games fall on days with no seat for them.`}
        {swing.length > 0 && ` In play: ${swing.join(', ')}.`}
      </p>
      {w.odds && <div className="nl-subh">Each category: so far · your chance to win it · where it ends up</div>}
      {w.odds && (
        <div className="nl-cats">
          {w.odds.races.map((r) => (
            <div key={r.cat} className={`nl-cat ${r.state}`} title={STATE_WORD[r.state]}>
              <div className="nl-catk">{LABEL[r.cat]}</div>
              <div className="nl-catv">{fmt(r.cat, r.mineNow)}<span>–{fmt(r.cat, r.theirsNow)}</span></div>
              <div className="nl-catp">{pct(r.win + r.tie / 2)}</div>
              <div className="nl-catf">→ {fmt(r.cat, r.mine)}–{fmt(r.cat, r.theirs)}</div>
            </div>
          ))}
        </div>
      )}
      {w.odds && w.players.length > 0 && (
        <Section title="Your players this week" hint="expected starts and what they produce">
          <div className="nl-scroll">
            <table className="nl-table nl-wkp">
              <thead><tr><th className="l">Player</th><th title="Expected starts this week: his games with a lineup spot, less his chance of sitting hurt">Starts</th><th title="Projected minutes a game">MPG</th>
                {YCOLS.map((c) => <th key={c.key} className={c.cat && swingCats.has(c.cat) ? 'nl-inplay' : c.dim ? 'nl-dimh' : ''} title={c.cat && swingCats.has(c.cat) ? 'In play this week' : undefined}>{c.label}</th>)}</tr></thead>
              <tbody>
                {w.players.map((p) => (
                  <tr key={p.id} className={p.starts < 0.5 ? 'nl-idle' : ''}>
                    <td className="l">{p.name}</td><td>{p.starts.toFixed(1)}</td><td>{p.mpg != null ? p.mpg.toFixed(0) : '—'}</td>
                    {YCOLS.map((c) => <td key={c.key} className={c.cat && swingCats.has(c.cat) ? 'nl-inplay' : c.dim ? 'nl-dim' : ''}>{c.cell(p.box)}</td>)}
                  </tr>
                ))}
                <tr className="nl-total"><td className="l">Your week</td><td>{w.players.reduce((a, p) => a + p.starts, 0).toFixed(0)}</td><td />
                  {YCOLS.map((c) => { const t = w.players.reduce((a, p) => addBoxUI(a, p.box), emptyBoxUI()); return <td key={c.key} className={c.cat && swingCats.has(c.cat) ? 'nl-inplay' : c.dim ? 'nl-dim' : ''}>{c.cell(t)}</td> })}</tr>
              </tbody>
            </table>
          </div>
          <p className="nl-note">Expected starts times his per-game line. Highlighted columns are this week's categories in play (35–65%): the players strongest in them are the ones not to bench, and what a stream should bring.</p>
        </Section>
      )}
      <Section title="Days left" hint="your 10 lineup spots, day by day">
        <DaysLeft w={w} />
      </Section>
      <p className="nl-note">Each category is the week so far plus what both lineups are expected to do from here, seated day by day. A race at 35–65% is in play: that is where a stream helps.</p>
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
      <Section title="For the rest of the season" hint="better than someone you have">
        {!ups.length && <div className="nl-none">Nobody on the wire beats your roster by enough to spend an add.</div>}
        {ups.map((p) => <PickupRow key={p.add} p={p} cats={cats} />)}
      </Section>
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
 * One pickup: who to add and drop, whether he is a free agent (now) or on waivers (a claim, a day), what it does for
 * the rest of the season and, separately, for this week, which can disagree; the other players he could replace.
 */
function PickupRow({ p, cats, over }: { p: SeasonView['pickups'][number]; cats: boolean; over?: boolean }) {
  const wk = (g: number) => (cats ? `${g >= 0 ? '+' : ''}${g.toFixed(2)} cats` : `${g >= 0 ? '+' : ''}${g.toFixed(0)} pts`)
  const weekCost = p.winAfter < p.winBefore - 0.02
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
        {p.kind !== 'stream' && <span title="His value over the games he has left, less the dropped player's: categories in play, summed per game">Season: +{Math.round(p.seasonGain)} value</span>}
        {p.kind !== 'stream' && ' · '}
        <span className={weekCost ? 'nl-cost' : ''}>This week: win {pct(p.winBefore)} → {pct(p.winAfter)} ({wk(p.weekGain)}){weekCost ? ' — costs this week' : ''}</span>
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
        <div className="nl-pickd nl-dim">Or drop: {p.alternatives.map((a, i) => <span key={a.drop}>{i ? ' · ' : ''}{a.dropName} <span title="this week's win chance after the move">(week {pct(a.winAfter)}, season +{Math.round(a.seasonGain)})</span></span>)}</div>
      )}
    </div>
  )
}

const dateWord = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

// ── News ──

const WHOSE: Record<string, string> = { mine: 'Your players', opponent: 'This week’s opponent', free: 'Free agents', other: 'Elsewhere' }

function News({ v }: { v: SeasonView }) {
  if (!v.news.length) return <div className="ckempty">Nothing new.</div>
  const groups = ['mine', 'opponent', 'free', 'other'].map((w) => [w, v.news.filter((n) => n.whose === w)] as const).filter(([, xs]) => xs.length)
  return (
    <>
      {groups.map(([w, xs]) => (
        <Section key={w} title={WHOSE[w]}>
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

function Season({ v }: { v: SeasonView }) {
  const [exp, setExp] = useState<{ name: string; leagues: { label: string; starting: boolean }[]; status: string }[] | null>(null)
  useEffect(() => { fetch('/api/nba/season/exposure').then((r) => r.json()).then(setExp).catch(() => {}) }, [])
  const cats = v.league.scoring === 'categories'
  const ap = v.allPlay
  const po = v.playoffs
  const CAT_ORDER: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
  return (
    <>
      <a className="nl-room" href={`/nba/draft/${v.league.id}`}><span className="nl-roomk">Draft</span><span>How the draft came out, and the room</span><span className="ckchev">›</span></a>
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
