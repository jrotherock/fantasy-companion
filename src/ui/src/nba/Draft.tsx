/**
 * The basketball draft screen, in football's layout and with football's parts.
 *
 * Eyes go first to the fixed top: the clock, three players to take with this
 * pick, the plan for the next one, and the build. Below it one panel scrolls:
 * the next-picks strip and the board, for looking things up.
 *
 * Nothing here works anything out. The server sends the whole view, worked out
 * once per change, and this draws it; the screen polls every two seconds.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraftView, BoardRow, PathView } from '../../../nba/plan'
import type { Cat } from '../../../nba/value'

const CATS: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
const LABEL: Record<Cat, string> = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' }
const pct = (x: number) => `${Math.round(x * 100)}%`
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const POSITIONS = ['All', 'PG', 'SG', 'SF', 'PF', 'C']

type Tag = 'never' | 'avoid' | 'like'

/** Playoff games read against what most teams play: more is good, fewer is a warning. */
const po = (n: number, norm: number | null) => (norm == null || n === norm ? 'nb-dim' : n > norm ? 'nb-up' : 'nb-down')

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
  // Every second when my turn is two picks away or less, where a stale screen is felt; every two otherwise.
  const near = view != null && view.clock.picksUntil != null && view.clock.picksUntil <= 2 && !view.clock.done
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, near ? 1000 : 2000)
    return () => clearInterval(t)
  }, [refresh, near])
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
  // The draft hub is gone: each league's page holds its draft prep.
  if (!id) { location.replace('/home'); return null }
  return <Screen id={id} />
}

/** Where ← leads: the league's page, or for a mock the page of the league it copies. */
const leaguePage = (view: DraftView) => `/nba/league/${view.mock?.baseId ?? view.league.id}`

// ── The draft screen ─────────────────────────────────────────────────────────
//
// Football's layout and football's parts (statusbar, clockpill, vhead, threeup,
// vc, chip, btn from styles.css): a fixed decision area — the clock, three
// players to take now, the plan, the build — over one scrolling panel holding
// the next-picks strip and the board. Who picks before you is a drawer, since
// it is wanted about once.

type Act = (p: string, d?: unknown) => void

/** Guard, big or mixed lean of a path's next picks, from their positions. */
function lean(plan: PathView['plan']): 'guard' | 'big' | 'mixed' {
  let g = 0, b = 0
  for (const p of plan.slice(0, 4)) {
    if (p.positions.includes('C')) b++
    else if (p.positions.includes('PG') || (p.positions.includes('SG') && !p.positions.includes('PF'))) g++
  }
  return g >= b + 2 ? 'guard' : b >= g + 1 ? 'big' : 'mixed'
}
const LEAN_TEXT = { guard: 'leans guard', big: 'leans big', mixed: 'mixed guards and bigs' }
/** Green yours, pale green leaning yours, amber leaning theirs, red mostly lost. */
const tone = (w: number) => (w >= 0.6 ? 'g' : w >= 0.5 ? 'l' : w >= 0.35 ? 'a' : 'r')

function Screen({ id }: { id: string }) {
  const { view, error, act } = useDraft(id)
  const [drawer, setDrawer] = useState(false)
  const [rosterOpen, setRosterOpen] = useState(false)
  // The review arrives at the top of the scrolling panel; bring it into view, since the eyes were on the board.
  const reviewed = !!view?.review
  useEffect(() => {
    if (!reviewed) return
    document.querySelector('.nb-panel')?.scrollTo({ top: 0, behavior: 'smooth' })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [reviewed])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  if (!view) return <div className="nb-pick"><p className="nb-dim">{error ?? 'Loading the board…'}</p></div>
  const cats = view.league.scoring === 'categories'
  return (
    <div className="nb-app">
      <div className="nb-fixed">
        <Status view={view} error={error} act={act} rosterOpen={rosterOpen} setRosterOpen={setRosterOpen} drawer={drawer} setDrawer={setDrawer} />
        {rosterOpen && <RosterLine view={view} />}
        {view.league.slot == null ? <Gate view={view} act={act} />
          : view.review ? null
          : <>
              <Notice view={view} />
              <Take view={view} act={act} />
              {cats && <Build view={view} act={act} />}
            </>}
      </div>
      {view.league.slot != null && (
        <div className="nb-panel">
          {/* Once the draft is done nothing is on the clock, so the review scrolls with the board rather than pinning it out of sight. */}
          {view.review && <Review view={view} act={act} />}
          <NextPicks view={view} />
          <Room view={view} />
          <Board view={view} act={act} id={id} />
        </div>
      )}
      {drawer && <Before view={view} id={id} close={() => setDrawer(false)} />}
    </div>
  )
}

function Status({ view, error, act, rosterOpen, setRosterOpen, drawer, setDrawer }: {
  view: DraftView; error: string | null; act: Act; rosterOpen: boolean; setRosterOpen: (b: boolean) => void; drawer: boolean; setDrawer: (b: boolean) => void
}) {
  const c = view.clock, s = view.sensor
  const age = s.at ? Math.round((Date.now() - s.at) / 1000) : null
  const feed = !s.at ? 'down' : !s.ok ? 'down' : age! > 30 ? 'stale' : 'ok'
  const said = !s.at ? 'NO FEED — ENTER PICKS BY HAND' : !s.ok ? `FEED: ${s.error}` : `${s.source === 'api' ? 'YAHOO API' : 'YAHOO PAGE'} · ${age}s`
  return (
    <div className="statusbar">
      <a className="nb-home" href={leaguePage(view)} title="The league's page">←</a>
      {c.done ? <span className="clockpill waiting">DONE</span>
        : view.review ? <span className="clockpill waiting">YOUR DRAFT IS DONE</span>
        : view.league.slot == null ? <span className="clockpill waiting">PICK {c.overall}</span>
        : c.onClock ? <span className="clockpill">PICK {c.overall} — YOU</span>
        : <span className="clockpill waiting">PICK {c.overall}</span>}
      <span>RD {c.round}{c.myNext != null && !c.onClock ? ` · NEXT ${c.myNext} (${c.picksUntil} away)` : ''}</span>
      <span className={`feed ${feed}`} title={s.unresolved.length ? `couldn't place ${s.unresolved.join(', ')}` : undefined}><i />{said}</span>
      {error && <span className="nb-down">{error}</span>}
      <span className="spacer" />
      <span>{view.league.label.toUpperCase()} · {view.league.scoring === 'points' ? 'POINTS' : '9-CAT'}{view.mock ? ' · MOCK' : ''}</span>
      {view.league.slot != null && (
        <button className="chip" title="Change your draft slot — Yahoo can reshuffle the order before the draft" onClick={() => act('slot', { slot: null })}>SLOT {view.league.slot}</button>
      )}
      <span className={`chip ${view.neverCount ? 'nb-chip-ok' : 'nb-chip-warn'}`} title="Players the advice never offers; tag them on the board">
        {view.neverCount ? `NEVER ${view.neverCount}` : 'NEVER LIST EMPTY'}
      </span>
      {view.history && <button className={`chip ${drawer ? 'on' : ''}`} onClick={() => setDrawer(!drawer)}>BEFORE YOU ▸</button>}
      <button className={`chip ${rosterOpen ? 'on' : ''}`} onClick={() => setRosterOpen(!rosterOpen)}>ROSTER {view.roster.length} {rosterOpen ? '▾' : '▸'}</button>
    </div>
  )
}

function RosterLine({ view }: { view: DraftView }) {
  return (
    <div className="nb-roster">
      {view.roster.map((r) => <span key={r.id}><span className="mono nb-dim">R{r.round}</span> {r.name} <span className="nb-dim">{r.positions.join(',')}</span></span>)}
      {!view.roster.length && <span className="nb-dim">No picks yet.</span>}
      {view.roster.length > 0 && view.stillToFill.count > 0 && (
        <span className="nb-amber" title="Seats your roster cannot fill yet; any of these can be the open one">
          Still need: {view.stillToFill.count === view.stillToFill.options.length
            ? view.stillToFill.options.join(', ')
            : `${view.stillToFill.count} of ${view.stillToFill.options.join(', ')}`}
        </span>
      )}
    </div>
  )
}

/** Football's slot gate: the same look and the same reason to exist. */
function Gate({ view, act }: { view: DraftView; act: Act }) {
  return (
    <div className="gate">
      <h2>Which slot are you?</h2>
      <p>
        {view.league.label} · {view.league.teams} teams.{' '}
        {view.mock ? 'A mock uses made-up team names, so count your place in the draft room\'s order'
          : 'Yahoo sets the order before the draft and the companion reads it the moment it is posted; until then, set it here'}{' '}
        — almost every number in here depends on it.
      </p>
      <div className="slots">
        {Array.from({ length: view.league.teams }, (_, i) => <button className="slotbtn" key={i} onClick={() => act('slot', { slot: i + 1 })}>{i + 1}</button>)}
      </div>
    </div>
  )
}

/** The latest change worth a glance, for a few minutes after it happens. */
function Notice({ view }: { view: DraftView }) {
  const f = view.feed[0]
  if (!f || Date.now() - f.at > 3 * 60_000) return null
  const kind = f.kind === 'build' ? 'BUILD' : f.kind === 'lock' ? 'LOCK' : f.kind === 'target' ? 'TARGET' : f.kind === 'run' ? 'RUN' : 'NOTE'
  return <div className={`nb-notice ${f.kind === 'build' || f.kind === 'lock' ? 'nb-notice-build' : ''}`}><span className="nb-notice-h">{kind}</span>{f.text}</div>
}

function reasons(contrib: Record<Cat, number> | undefined, locks: Cat[]) {
  if (!contrib) return null
  const live = CATS.filter((c) => !locks.includes(c))
  const up = live.filter((c) => contrib[c] > 0.25).sort((a, b) => contrib[b] - contrib[a]).slice(0, 3)
  const down = live.filter((c) => contrib[c] < -0.25).sort((a, b) => contrib[a] - contrib[b]).slice(0, 2)
  return <>{up.map((c) => <span key={c} className="nb-up">+{LABEL[c]}</span>)}{down.map((c) => <span key={c} className="nb-down">−{LABEL[c]}</span>)}</>
}

function Take({ view, act }: { view: DraftView; act: Act }) {
  const cards = view.takeNow
  if (!cards.length) return null
  const onClock = view.clock.onClock
  const close = cards.length > 1 && cards[0].score - cards[1].score < (view.league.scoring === 'categories' ? 0.02 : Math.abs(cards[0].score) * 0.01)
  const locks = view.build?.locks ?? []
  const next = view.ahead[0]
  return (
    <div>
      <div className="vhead">
        <span className="vlabel">{onClock ? 'TAKE' : `LIKELY THERE AT YOUR PICK ${view.clock.myNext}`}</span>
        {onClock && <span className={`conf ${close ? 'close' : 'clear'}`}>{close ? 'close call' : 'clear pick'}</span>}
        {cards[0].tiebreak && <span className="conf close">playoff tiebreak</span>}
      </div>
      <div className="threeup">
        {cards.map((a, i) => (
          <div key={a.id} className={`vc ${i === 0 ? 'sel' : ''}`}>
            <span className="rk">{i + 1}{i === 0 && onClock ? ' · TAKE' : ''}</span>
            <span className="nm">{a.name}{a.tag === 'like' && <span className="nb-tag nb-like">like</span>}{a.tag === 'avoid' && <span className="nb-tag nb-avoid">avoid</span>}</span>
            <span className="sub">{a.team} · {a.positions.join(', ')}</span>
            <div className="nb-reason">
              {reasons(a.contrib, locks)}
              {a.fpg != null && <span>{a.fpg.toFixed(1)} fp/g</span>}
              <span className="nb-dim">{Math.round(a.gp)} g</span>
              {a.playoff != null && <span className={po(a.playoff, view.playoffNorm)}>{a.playoff} PO g</span>}
              {a.returnNote && <span className="nb-down">{a.returnNote}</span>}
              {a.bestBuild && a.bestBuild.name !== view.aheadBuild && <span className="nb-bb">{ordinal(a.bestBuild.rank)} if {a.bestBuild.name.replace(/^Punt /, 'you punt ')}</span>}
            </div>
            {(a.fits.length > 0 || a.stacks.length > 0 || a.hurts.length > 0) && (
              <div className="nb-fits">
                {[
                  a.fits.length > 0 && view.weakSpots && <span key="m">moves {view.weakSpots.whose} close {a.fits.map((c) => LABEL[c]).join(', ')}</span>,
                  a.hurts.length > 0 && view.weakSpots && <span key="h" className="nb-hurts">hurts {view.weakSpots.whose} close {a.hurts.map((c) => LABEL[c]).join(', ')}</span>,
                  a.stacks.length > 0 && <span key="s" className="nb-stacks">stacks {view.weakSpots?.whose ?? 'your'} {a.stacks.map((c) => LABEL[c]).join(', ')}</span>,
                ].filter(Boolean).flatMap((el, i) => (i ? [<span key={`d${i}`}> · </span>, el] : [el]))}
              </div>
            )}
            <div className={`nb-fate ${a.there != null || a.canWait ? 'nb-wait' : 'nb-gone'}`}>
              {a.there != null ? `${pct(a.there)} there at pick ${view.clock.myNext}` : a.canWait ? `${pct(a.survives)} back next turn — can wait` : `${pct(1 - a.survives)} gone by your next turn`}
            </div>
            <button className={`btn ${i === 0 && onClock ? 'primary' : ''}`} onClick={() => act('pick', { playerId: a.id })}>Mark drafted</button>
          </div>
        ))}
      </div>
      {onClock && (
        <div className="nb-plan">
          <span className="vlabel">PLAN</span> {cards[0].name} now
          {view.canWait.length > 0 && next ? <> → {view.canWait.map((w, i) => <span key={w.name}>{i ? ', ' : ''}{w.name} <span className="nb-dim">{pct(w.survives)}</span></span>)} — likely still there at pick {next.overall}</> : null}
        </div>
      )}
      {view.playoffNote && <div className="nb-ponote">{view.playoffNote}</div>}
    </div>
  )
}

function Build({ view, act }: { view: DraftView; act: Act }) {
  const b = view.build!
  const [confirm, setConfirm] = useState<Cat | null>(null)
  const [help, setHelp] = useState(false)
  const win = b.win
  // Before the build is read the numbers are real but young: one or two players against an average start.
  const early = b.stage === 'open'
  const live = CATS.filter((c) => !b.locks.includes(c))
  const count = (t: string) => (win ? live.filter((c) => tone(win[c]) === t).length : 0)
  const tap = (c: Cat) => (b.locks.includes(c) ? act('locks', { locks: b.locks.filter((x) => x !== c) }) : setConfirm(c))
  const p = view.paths
  const gap = p.length > 1 ? p[0].expected - p[1].expected : 0
  const spread = p.length > 2 ? p[0].expected - p[2].expected : gap
  const lead = p[0] ? lean(p[0].plan) : 'mixed'
  return (
    <div className="nb-build">
      <div className="nb-bhead">
        <span className="vlabel">YOUR BUILD</span><span className="nb-dim nb-small">weekly win chance per category</span>
        <span className="spacer" /><button className="nb-link" onClick={() => setHelp(!help)}>{help ? 'Hide help' : 'How to read this'}</button>
      </div>
      <div className="nb-cats">
        {CATS.map((c) => b.locks.includes(c)
          ? <button key={c} className="nb-cat nb-cat-lock" onClick={() => tap(c)} title="Locked as a punt — click to unlock"><span className="l">{LABEL[c]}</span><span className="v">punt 🔒</span></button>
          : <button key={c} className={`nb-cat ${win ? `nb-cat-${tone(win[c]) || 'even'}` : 'nb-cat-open'}${early ? ' nb-cat-early' : ''}`} onClick={() => tap(c)} title={early ? 'Early: moves a lot until your 4th pick. Click to lock as a punt' : 'Click to lock as a punt'}><span className="l">{LABEL[c]}</span><span className="v">{win ? pct(win[c]) : '—'}</span></button>)}
      </div>
      <div className="nb-bfoot">
        {win ? (
          <div className="nb-meter">
            <span><i className="nb-dot" style={{ background: 'var(--green)' }} />{count('g')} winning</span>
            <span><i className="nb-dot nb-dot-lean" />{count('l')} leaning</span>
            <span><i className="nb-dot" style={{ background: 'var(--amber)' }} />{count('a')} coin flips</span>
            <span><i className="nb-dot" style={{ background: 'var(--red)' }} />{count('r') + b.locks.length} given up</span>
            <span className="mono">{live.reduce((s, c) => s + win[c], 0).toFixed(1)} of 9 a week</span>
            <span className="nb-dim">{early
              ? `Early — after ${view.roster.length} pick${view.roster.length === 1 ? '' : 's'}, against an average team's first ${view.roster.length}. These move a lot until your ${b.buildFrom}th pick; until then the cards take the best player.`
              : 'Goal: 5–6 winning, 2–3 given up on purpose.'}</span>
          </div>
        ) : <div className="nb-meter nb-dim">Win chances show from your first pick. Until your {b.buildFrom}th the cards take the best player; the direction is a lean, not a plan.</div>}
        {p.length > 1 && (
          <div className="nb-dir">
            <div className="nb-arrow">{gap < 0.15 ? `→ Open · top builds within ${spread.toFixed(2)}` : `→ ${p[0].name} · ${LEAN_TEXT[lead]}`}</div>
            <div className="nb-small">
              {gap < 0.15 ? `No build is clearly better — take the best player. The leader ${LEAN_TEXT[lead]}.`
                : `Leads by ${gap.toFixed(2)} a week${view.roster.length < b.buildFrom ? '; a lean from your first picks, not a plan yet' : ''}. Next: ${p[0].plan.slice(0, 3).map((x) => x.name).join(', ')}.`}
            </div>
            <div className="nb-builds">
              {p.slice(0, 3).map((x, i) => (
                <button key={x.name} className={`chip ${i === 0 ? 'on' : ''}`} title={`next: ${x.plan.slice(0, 3).map((q) => q.name).join(', ')}`}
                  onClick={() => x.punt.length ? act('locks', { locks: x.locked ? [] : x.punt }) : undefined}>
                  {x.name} · {lean(x.plan)} · {x.expected.toFixed(2)}{x.locked ? ' 🔒' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {confirm && (
        <div className="nb-confirm">
          Lock <b>{LABEL[confirm]}</b> as a punt? You win it {win ? pct(win[confirm]) : '—'} of weeks. The advice stops paying for {LABEL[confirm]} and spends picks on the rest. Unlock any time.
          <button className="btn primary" onClick={() => { act('locks', { locks: [...b.locks, confirm] }); setConfirm(null) }}>Lock it</button>
          <button className="nb-link" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {help && (
        <div className="nb-help">
          <h4>Your build</h4>Each tile is your chance of winning that category in a typical week against an average team. You win a week with 5 of 9.
          <ul>
            <li><span className="nb-up">Green 60%+</span> — usually yours. Five or six is a contender.</li>
            <li><span className="nb-lean">Pale green 50–59%</span> — leaning yours: more often yours than not, not one to count on.</li>
            <li><span className="nb-amber">Amber 35–49%</span> — the expensive middle: paid for, still lost half the time. Push it up or give it up.</li>
            <li><span className="nb-down">Red under 35%</span> — mostly lost. The advice already stops spending on it.</li>
            <li>All green is not the goal. A clear shape is.</li>
          </ul>
          <h4>Locking a punt — usually don't</h4>
          <ul>
            <li>From your {b.buildFrom}th pick the advice leans away from categories you are unlikely to win on its own, and keeps the lean soft: if later picks make one winnable again, it counts again.</li>
            <li>A lock gives the category up for good. In 400 simulated Hoops drafts every lock lost to not locking — locking the weakest at pick 4 by 1.5 points of weekly win chance, at pick 2 by 2.6, two categories at pick 4 by 3.6, and locking straight after a punt-built pick like Giannis by 3.4. Later locks cost less; none gained.</li>
            <li>Lock only to say something the app cannot know — that you will not chase a category whatever happens. Click a tile or a build chip to lock; click again to unlock.</li>
          </ul>
          <h4>Direction</h4>Where your picks so far point, and the top three builds with the categories each should win a week. Before pick {b.buildFrom} it is a lean; when builds are within about 0.15 it says so, and the best player is the right pick.
        </div>
      )}
    </div>
  )
}

function Review({ view }: { view: DraftView; act: Act }) {
  const r = view.review!
  return (
    <div className="nb-build">
      <div className="nb-bhead"><span className="vlabel">HOW IT CAME OUT</span><span className="spacer" />{view.mock && <a className="nb-link" href={`${leaguePage(view)}#mocks`}>What all your mocks say →</a>}</div>
      {r.expected != null && r.win && <>
        <div className="nb-bignum">{r.expected.toFixed(1)} <span className="nb-dim">of 9 categories a week</span></div>
        <div className="nb-cats">{CATS.map((c) => <div key={c} className={`nb-cat nb-cat-${tone(r.win![c]) || 'even'}`}><span className="l">{LABEL[c]}</span><span className="v">{pct(r.win![c])}</span></div>)}</div>
        <div className="nb-meter">{r.punting.length ? `Punted ${r.punting.map((c) => LABEL[c]).join(', ')}` : 'Nothing punted'}</div>
      </>}
      {r.value != null && <div className="nb-bignum">{Math.round(r.value)} <span className="nb-dim">season value over replacement</span></div>}
      <div>Took the advice at {r.followed} of {r.advisedPicks} picks.</div>
      {r.departures.length > 0 && <ul className="nb-list">{r.departures.map((d, i) => <li key={i}><span className="mono nb-dim">R{d.round}</span> took {d.took} <span className="nb-dim">— advice was {d.advised}</span></li>)}</ul>}
      {r.room && <>
        <div className="nb-bhead"><span className="vlabel">THE ROOM</span><span className="nb-dim nb-small">{r.expected != null ? 'categories a week against an average team' : 'season value over replacement'}</span></div>
        <ol className="nb-room">{r.room.map((t) => (
          <li key={t.seat} className={t.mine ? 'mine' : ''}>
            <span className="mono nb-dim">{t.rank}.</span> {t.mine ? 'You' : t.manager ?? `Pick ${t.seat}`}{(t.mine || t.manager) && <span className="nb-dim"> pick {t.seat}</span>}
            {t.picks < t.of && <span className="nb-dim nb-small">{t.picks} of {t.of} picks read</span>}
            <span className="spacer" /><b className="mono">{r.expected != null ? t.score.toFixed(2) : Math.round(t.score)}</b>
          </li>
        ))}</ol>
      </>}
      {view.mock && <button className="btn" onClick={async () => { if (confirm('Discard this mock? It drops out of the comparison.')) { await post(`/api/nba/draft/${view.league.id}/discard`); location.href = leaguePage(view) } }}>Discard this mock</button>}
    </div>
  )
}

/**
 * Every team in the room, from its picks so far, as the draft goes: where mine
 * stands in one line, the whole table on a tap. Points leagues lead with points
 * a week from starts — the number that decides weeks — with value, season
 * points, a full night's points a game and points a minute beside it.
 */
function Room({ view }: { view: DraftView }) {
  const [open, setOpen] = useState(false)
  const rows = view.liveRoom
  if (!rows?.length) return null
  const pts = view.league.scoring === 'points'
  const me = rows.find((r) => r.mine)
  // Mid-round some teams have a pick more; the rank is on the rounds everyone has finished.
  const full = Math.min(...rows.map((r) => r.picks))
  const who = (r: NonNullable<DraftView['liveRoom']>[number]) => (r.mine ? 'You' : r.manager ?? `Pick ${r.seat}`)
  const n = (x: number | null, d = 0) => (x == null ? '—' : x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }))
  return (
    <div className="nb-box nb-strip">
      <button className="nb-striphead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="nb-ph">THE ROOM {open ? '▾' : '▸'}</span>
        <span className="nb-stripline">
          {me ? <span>You: <b>{ordinal(me.rank)}</b> of {rows.length} · {pts ? `${n(me.pointsWeek)} pts a week` : `${n(me.catsWeek, 2)} categories a week`}</span> : <span className="nb-dim">your slot is not set</span>}
          {full > 0 && full < Math.max(...rows.map((r) => r.picks)) && <span className="nb-dim">ranked on the first {full} round{full === 1 ? '' : 's'}</span>}
          {rows[0] && !rows[0].mine && <span className="nb-dim">leader {who(rows[0])} {pts ? n(rows[0].pointsWeek) : n(rows[0].catsWeek, 2)}</span>}
        </span>
      </button>
      {open && <>
        <table className="nb-table nb-roomtable">
          <thead><tr>
            <th>#</th><th className="nb-l">Team</th><th title="Picks made so far">Picks</th>
            {pts ? <>
              <th title="Fantasy points a week from the games the roster would start: daily lineups, this league's seats, the real schedule">Pts/wk</th>
              <th title="Points a game above the replacement line, times games, summed">Value</th>
              <th title="Every player's projected points a game times his games, summed">FP season</th>
              <th title="Average points a game of the roster's best lineup's worth of players">FP/g</th>
              <th title="Points a game per minute played, across the roster">FP/min</th>
            </> : <th title="Categories a week against an average team with as many picks">Cats/wk</th>}
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.seat} className={r.mine ? 'nb-mine' : ''}>
              <td className="nb-dim">{r.rank}</td>
              <td className="nb-l">{who(r)} <span className="nb-dim">pick {r.seat}</span></td>
              <td>{r.picks}</td>
              {pts ? <>
                <td className="mono">{n(r.pointsWeek)}</td><td className="mono">{n(r.value)}</td><td className="mono">{n(r.fpSeason)}</td>
                <td className="mono">{n(r.fpNight, 1)}</td><td className="mono">{n(r.fpMin, 2)}</td>
              </> : <td className="mono">{n(r.catsWeek, 2)}</td>}
            </tr>
          ))}</tbody>
        </table>
        <p className="nb-small nb-dim">{pts
          ? 'Ranked by points a week: what each roster scores from the games it would start, with this league\u2019s seats and the real schedule — over the rounds every team has finished, so a pick in hand is not a lead. The table shows each team\u2019s full totals. Other teams are measured on the same projections as yours.'
          : 'Ranked by categories won a week against an average team with as many picks.'}</p>
      </>}
    </div>
  )
}

/** Your next picks in one line; open for the alternatives at each. */
function NextPicks({ view }: { view: DraftView }) {
  const [open, setOpen] = useState(false)
  if (!view.ahead.length) return null
  return (
    <div className="nb-box nb-strip">
      <button className="nb-striphead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="nb-ph">NEXT PICKS {open ? '▾' : '▸'}</span>
        <span className="nb-stripline">
          {view.ahead.map((a) => { const p = a.players.find((x) => x.planned) ?? a.players[0]; return <span key={a.overall}><span className="mono nb-dim">R{a.round} #{a.overall}</span> {p.name} <span className="nb-dim">{pct(p.survives)}</span></span> })}
        </span>
      </button>
      {open && <>
        <ul className="nb-ahead">
          {view.ahead.map((a) => (
            <li key={a.overall}>
              <span className="mono nb-dim">R{a.round} · pick {a.overall}</span>
              <span className="nb-who">{a.players.map((p) => <span key={p.id} className={p.planned ? 'nb-planned' : ''}>{p.name} <span className="nb-dim">{p.positions[0]} {pct(p.survives)}</span></span>)}</span>
            </li>
          ))}
        </ul>
        <p className="nb-small nb-dim">Bold is the plan for that pick under {view.aheadBuild}; the others are worth having and likely there. Percent: chance he lasts to that pick.</p>
      </>}
    </div>
  )
}

type SortKey = 'rank' | 'gp' | 'po' | 'adp' | 'next' | Cat | 'fpg' | 'fpMin' | 'fpSeason' | 'value'

/** A column's value for sorting, oriented so bigger is better: earlier ADP sorts first, turnovers are already flipped. */
function sortValue(r: BoardRow, key: SortKey): number {
  const missing = -1e9
  switch (key) {
    case 'rank': return -r.rank
    case 'gp': return r.gp
    case 'po': return r.playoff ?? missing
    case 'adp': return r.adp == null ? missing : -r.adp
    case 'next': return r.survives ?? missing
    case 'fpg': return r.fpg ?? missing
    case 'fpMin': return r.fpMin ?? missing
    case 'fpSeason': return r.fpSeason ?? missing
    case 'value': return r.value
    default: return r.contrib?.[key] ?? missing
  }
}

function Board({ view, act, id }: { view: DraftView; act: Act; id: string }) {
  const [pos, setPos] = useState('All')
  const [q, setQ] = useState('')
  const [showTaken, setShowTaken] = useState(false)
  const [help, setHelp] = useState(false)
  const cats = view.league.scoring === 'categories'
  const locks = view.build?.locks ?? []
  const win = view.build?.win ?? null
  const need = win ? CATS.filter((c) => !locks.includes(c) && win[c] >= 0.35 && win[c] < 0.5) : []
  // Sorting by any column header: best first on the first click, reversed on the second; # is the build's own order.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)
  const by = (key: SortKey) => setSort((cur) => (key === 'rank' ? null : cur?.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  const arrow = (key: SortKey) => (sort?.key === key ? (sort.dir === 1 ? ' ▼' : ' ▲') : key === 'rank' && !sort ? ' ▼' : '')
  const th = (key: SortKey, label: string, extra: { className?: string; title?: string } = {}) => (
    <th className={`nb-sort ${extra.className ?? ''} ${sort?.key === key || (key === 'rank' && !sort) ? 'nb-sorted' : ''}`} title={extra.title} onClick={() => by(key)}>{label}{arrow(key)}</th>
  )
  const filtered = view.board.filter((r) =>
    (showTaken || r.takenAt == null) && (pos === 'All' || r.positions.includes(pos)) && (!q || r.name.toLowerCase().includes(q.toLowerCase())))
  const rows = (sort ? [...filtered].sort((a, b) => sort.dir * (sortValue(b, sort.key) - sortValue(a, sort.key))) : filtered).slice(0, 150)
  const tag = (r: BoardRow, t: Tag) => act('tag', { playerId: r.id, tag: r.tag === t ? null : t })
  const heat = (v: number) => { const a = Math.min(1, Math.abs(v) / 1.2) * 0.55; return { background: v >= 0 ? `rgba(69,217,160,${a})` : `rgba(255,92,99,${a})` } }
  return (
    <div className="nb-box">
      <div className="nb-boardhead">
        <span className="nb-ph">BOARD · RANKED FOR {cats ? (locks.length ? 'YOUR LOCKED PUNT' : (view.aheadBuild || 'BALANCED').toUpperCase()) : 'POINTS'}</span>
        <Entry id={id} view={view} act={act} />
        <span className="spacer" />
        <button className="nb-link" onClick={() => setHelp(!help)}>{help ? 'Hide help' : 'How to use the board'}</button>
      </div>
      {help && (
        <div className="nb-help">
          <ul>
            <li><b>#</b> is value for your build; it re-ranks when you lock, and locked columns fade. Click any column header to sort by it — best first, again to reverse — and # to go back.</li>
            <li><b>Coloured cells</b>: what a player adds per category over a season. Read down the <span className="nb-amber">amber headers</span> — your coin flips — to find who tips one to green.</li>
            {!cats && <li><b>FP/g</b> fantasy points a game; <b>FP/min</b> per minute he is projected to play — high means he scores in what he gets, so more minutes would show; <b>FP season</b> a game times his games. <b>Value</b> is not the season total: it is points a game above the replacement line times games, so a replacement-level player is worth nought however much he scores.</li>}
            {cats && <li><b>Blue note</b> beside a name: where he ranks in the build he is drafted for, when that is 20+ places higher than balanced — Giannis is a first-rounder only if your roster ends up punting FT%. Information: the cards already weigh it once your roster leans that way, without a lock.</li>}
            <li><b>Next</b>: chance he lasts to your next pick. Above about 60%, he can wait. <b>PO</b>: games in your playoff weeks, the tiebreaker.</li>
            <li>Grey rows are your never list. A red note means he starts the season hurt; set your own return date beside it.</li>
            <li>Check a name here; let the cards above make the call.</li>
          </ul>
        </div>
      )}
      <div className="filters nb-filters">
        <input className="field" value={q} placeholder="Filter" onChange={(e) => setQ(e.target.value)} />
        {POSITIONS.map((p) => <button key={p} className={`chip ${pos === p ? 'on' : ''}`} onClick={() => setPos(p)}>{p.toUpperCase()}</button>)}
        <button className={`chip ${showTaken ? 'on' : ''}`} onClick={() => setShowTaken(!showTaken)}>DRAFTED</button>
      </div>
      <div className="nb-tablewrap">
        <table className="nb-table">
          <thead>
            <tr>
              {th('rank', '#')}<th className="nb-l">Player</th><th>Pos</th>{th('gp', 'G')}{th('po', 'PO', { title: 'Games in your playoff weeks' })}{th('adp', 'ADP')}{th('next', 'Next', { title: 'Chance he lasts to your next decision' })}
              {cats
                ? CATS.map((c) => <Fragment key={c}>{th(c, LABEL[c], { className: locks.includes(c) ? 'nb-off' : need.includes(c) ? 'nb-need' : '' })}</Fragment>)
                : <>{th('fpg', 'FP/g', { title: 'Fantasy points a game' })}{th('fpMin', 'FP/min', { title: 'Fantasy points a minute' })}{th('fpSeason', 'FP season', { title: 'Fantasy points over the season: a game times games' })}{th('value', 'Value', { title: 'Points a game above the replacement line, times games' })}</>}
              <th title="never · avoid · like">Tag</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`${r.tag === 'never' ? 'nb-never' : ''} ${r.takenAt != null ? 'nb-taken' : ''} ${r.mine ? 'nb-mine' : ''}`}>
                <td className="nb-dim">{r.rank}</td>
                <td className="nb-l">
                  {r.name}
                  {r.tag && <span className={`nb-tag nb-${r.tag}`}>{r.tag}</span>}
                  {r.bestBuild && r.bestBuild.name !== view.aheadBuild && !locks.length && (
                    <span className="nb-bb" title={`${r.bestBuild.balanced}th balanced; ${ordinal(r.bestBuild.rank)} in a ${r.bestBuild.name} build`}>{ordinal(r.bestBuild.rank)} {r.bestBuild.name.replace(/^Punt /, 'punting ')}</span>
                  )}
                  {r.injury && !r.returnNote && <span className="nb-inj">{r.injury}</span>}
                  {r.returnNote && (
                    <span className="nb-return" title="When he is expected back; set your own date to override">
                      {r.returnNote}
                      <input type="date" aria-label={`Return date for ${r.name}`} onChange={(e) => act('return', { playerId: r.id, date: e.target.value || null })} />
                    </span>
                  )}
                  {r.takenAt != null && <span className="nb-dim nb-small"> #{r.takenAt}{r.takenBy ? ` ${r.takenBy}` : ''}</span>}
                  <span className="nb-dim nb-small"> {r.team}</span>
                </td>
                <td className="nb-dim">{r.positions.join(',')}</td>
                <td>{Math.round(r.gp)}</td>
                <td className={r.playoff != null ? po(r.playoff, view.playoffNorm) : 'nb-dim'}>{r.playoff ?? '—'}</td>
                <td className="nb-dim">{r.adp != null ? r.adp.toFixed(0) : '—'}</td>
                <td>{r.takenAt == null && r.survives != null ? pct(r.survives) : ''}</td>
                {cats ? CATS.map((c) => <td key={c} className={`mono ${locks.includes(c) ? 'nb-off' : ''}`} style={locks.includes(c) ? undefined : heat(r.contrib![c])}>{r.contrib![c].toFixed(1)}</td>)
                  : <><td className="mono">{r.fpg?.toFixed(1)}</td><td className="mono">{r.fpMin != null ? r.fpMin.toFixed(2) : '—'}</td><td className="mono">{r.fpSeason != null ? Math.round(r.fpSeason).toLocaleString() : ''}</td><td className="mono">{Math.round(r.value)}</td></>}
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
    </div>
  )
}

/** Typed entry for any team's pick, for when Yahoo is slow: "/" jumps here. */
function Entry({ id, view, act }: { id: string; view: DraftView; act: Act }) {
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
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === '/' && document.activeElement !== box.current) { e.preventDefault(); box.current?.focus() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  const pick = (playerId: string) => { act('pick', { playerId }); setQ(''); setHits([]) }
  void id
  return (
    <span className="nb-entry">
      <input ref={box} className="field" value={q} placeholder={`Enter pick ${view.clock.overall} ( / )`} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) pick(hits[0].id); if (e.key === 'Escape') setQ('') }} />
      <button className="btn" onClick={() => act('undo')} title="Take back the last pick you typed">Undo</button>
      {hits.length > 0 && (
        <ul className="nb-hits">
          {hits.map((h, i) => <li key={h.id}><button className={i === 0 ? 'nb-first' : ''} onClick={() => pick(h.id)}>{h.name} <span className="nb-dim">{h.team} · {h.positions.join(',')}</span></button></li>)}
        </ul>
      )}
    </span>
  )
}

/**
 * Who picks between now and my next turn, and what their own history says.
 * A drawer, opened when wanted: information, not prediction — the habits did
 * not beat ADP over twelve seasons, so the advice ignores them.
 */
function Before({ view, id, close }: { view: DraftView; id: string; close: () => void }) {
  const [asked, setAsked] = useState(false)
  const h = view.history!
  const load = async () => {
    setAsked(true)
    try { await post(`/api/nba/history/${id.replace(/-test$/, '')}`) } catch (e) { alert((e as Error).message) }
  }
  const rows = view.pickingBefore.filter((p) => p.manager)
  return (
    <>
      <div className="nb-scrim" onClick={close} />
      <aside className="nb-drawer" role="dialog" aria-label="Picking before you">
        <div className="nb-bhead"><span className="vlabel">PICKING BEFORE YOU</span>{h.seasons ? <span className="nb-dim nb-small">{h.seasons} seasons</span> : null}<span className="spacer" /><button className="chip" onClick={close}>✕</button></div>
        {!h.seasons && <p className="nb-small nb-dim">League history isn't loaded. <button className="nb-link" onClick={load} disabled={asked}>{asked ? 'Reading it from Yahoo…' : 'Read it from Yahoo'}</button> — only seasons you played in are used.</p>}
        {h.seasons > 0 && rows.length === 0 && <p className="nb-small nb-dim">{view.clock.onClock ? 'You are on the clock — nobody picks before you.' : 'Yahoo has not posted who sits where yet.'}</p>}
        <ul className="nb-list">
          {rows.map((p) => (
            <li key={p.overall}>
              <span className="mono nb-dim">#{p.overall}</span> <b>{p.manager}</b>
              {p.habits.length === 0 && <span className="nb-dim nb-small">{p.seasons ? ' — close to the league norm' : ' — no history'}</span>}
              {p.habits.map((x) => <div key={x.metric} className="nb-small">{x.text} <span className={`nb-tag ${x.consistent ? 'nb-hold' : ''}`}>{x.consistent ? 'holds' : 'unproven'}</span></div>)}
            </li>
          ))}
        </ul>
        {h.seasons > 0 && <p className="nb-small nb-dim">Information only: these habits did not predict picks better than ADP over this league's history, so the advice ignores them.</p>}
      </aside>
    </>
  )
}
