/**
 * Harker (points): do centers deserve to go earlier because they are scarce?
 *
 *   npx tsx scripts/nba-points-sim.ts [--seeds 20]
 *
 * Sixteen-team rooms drafting down Yahoo ADP with Harker's own measured
 * spread (1.5 + 0.10 * ADP), re-drawn identically for every strategy. Scored on
 * what wins a points week: fantasy points from the games each player actually
 * starts — daily lineups in Harker's seven seats (one C, two Util) over the real
 * schedule — compared head to head with every roster in the room, with the
 * week-to-week spread the app uses (11% of the week's points). Reported as an
 * all-play win rate.
 */
import { readFileSync, existsSync } from 'node:fs'
import type { NbaPlayer } from '../src/nba/types.js'
import { pointsValues, rosterSpots } from '../src/nba/value.js'
import { adpFor, advisePoints, survives } from '../src/nba/draft.js'
import { positionalSlots, stillFeasible } from '../src/nba/lineup.js'
import { slotFor } from '../src/kernel/snake.js'
import { calendar, startShares } from '../src/nba/starts.js'
import { startingSeats } from '../src/nba/week.js'
import { seatPositions } from '../src/nba/inseason.js'
import { POINTS_WEEK_CV } from '../src/nba/strength.js'
import { gamesAfterReturn } from '../src/nba/plan.js'
import { NameIndex } from '../src/nba/join.js'
import { playSeason, rng as seasonRng, weeksOf, type SeasonPlayer } from '../src/nba/rawSeason.js'
import { perGameBox } from '../src/nba/outlook.js'
import { pointsOf } from '../src/nba/matchup.js'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null }
const SEEDS = Number(arg('seeds') ?? 20)
const SPREAD = { a: 1.5, b: 0.1 }

const rawPlayers: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const scheduleGames = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games as { date: string; home: string; away: string }[]
const teamDates: Record<string, string[]> = {}
for (const g of scheduleGames) for (const t of [g.home, g.away]) (teamDates[t] ??= []).push(g.date)
const nameIdx = new NameIndex(rawPlayers.map((p) => ({ id: p.id, name: p.name, team: p.team })))
const injuryNotes = new Map<string, any>()
for (const n of JSON.parse(readFileSync('data/nba/injuries.json', 'utf8')).injuries) {
  if (!n.returnDate && !n.outForSeason) continue
  const id = nameIdx.resolve(n.name, null)
  if (id) injuryNotes.set(id, { returnDate: n.returnDate, outForSeason: n.outForSeason, source: 'cbs', text: n.text })
}
// Players starting the season hurt are valued on the games after their return, as the app values them.
const players: NbaPlayer[] = rawPlayers.map((p) => {
  const av = injuryNotes.get(p.id)
  if (!av || !p.projection) return p
  return { ...p, projection: { ...p.projection, gp: gamesAfterReturn(p, av, teamDates, '2026-10-05').gp, gpSource: 'injury' as const } }
})
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === 'nba-harker')
const rounds = rosterSpots(league.roster)
const byId = new Map(players.map((p) => [p.id, p]))
const adp = (id: string) => adpFor(byId.get(id)!)
const { rows: prow } = pointsValues(players, league)
const rows = prow.map((r) => ({ ...r, adp: adp(r.id) }))
const rowOf = new Map(rows.map((r) => [r.id, r]))
const neverNames = existsSync('data/preferences/nba.json') ? (JSON.parse(readFileSync('data/preferences/nba.json', 'utf8')).never ?? []) : ['Anthony Davis', 'Joel Embiid', 'Kristaps Porziņģis']
const never = new Set(players.filter((p) => neverNames.includes(p.name)).map((p) => p.id))
const posOf = (id: string) => byId.get(id)!.yahoo?.positions ?? byId.get(id)!.positions
const isC = (id: string) => seatPositions(posOf(id)).includes('C')
const slots = positionalSlots(league.roster)
const canTake = (mine: string[]) => (id: string, after?: string) => {
  if (never.has(id)) return false
  const have = mine.map(posOf)
  const roster = after ? [...have, posOf(after)] : have
  return stillFeasible(roster, posOf(id), slots, rounds - roster.length - 1)
}

// ── Positional replacement: each player's value against the best player left at his best position ──
// Starting seats are filled league-wide position by position, Util last; the replacement at a
// position is the first player of it left over once every team's seats and bench are full.
const seats = startingSeats(league.roster)
function positionalValue(): Map<string, number> {
  const pool = rows.filter((r) => !never.has(r.id) && r.fpg > 0).sort((a, b) => b.season - a.season)
  const rostered = new Set(pool.slice(0, league.teams * rounds).map((r) => r.id))
  const repl: Record<string, number> = {}
  for (const P of ['PG', 'SG', 'SF', 'PF', 'C']) {
    const left = pool.filter((r) => !rostered.has(r.id) && seatPositions(posOf(r.id)).includes(P))
    repl[P] = left[0]?.fpg ?? 0
  }
  const out = new Map<string, number>()
  for (const r of rows) {
    const ps = seatPositions(posOf(r.id))
    // A multi-position player is measured against the lowest bar he can clear: his scarcest position.
    const line = ps.length ? Math.min(...ps.map((p) => repl[p] ?? Infinity)) : 0
    out.set(r.id, (r.fpg - line) * (r.fpg >= line ? r.games.gp : 82))
  }
  console.error('replacement fp/g by position:', JSON.stringify(Object.fromEntries(Object.entries(repl).map(([k, v]) => [k, +v.toFixed(1)]))))
  return out
}
const posValue = positionalValue()

// ── Strategies ──

type Pick = (avail: string[], mine: string[], overall: number, slot: number) => string
const app = (vals?: Map<string, number>, naiveTurns = false, unconditional = false): Pick => (avail, mine, overall, slot) => {
  const pool = avail.map((id) => rowOf.get(id)!).filter(Boolean).map((r) => (vals ? { ...r, value: vals.get(r.id) ?? r.value } : r))
  const advice = advisePoints(pool, { teams: league.teams, rounds, slot, overall, spread: SPREAD, naiveTurns, unconditional }, 25, canTake(mine))
  return advice[0]?.id ?? pool.find((r) => canTake(mine)(r.id))!.id
}
const cBy = (n: number): Pick => (avail, mine, overall, slot) => {
  if (mine.length + 1 >= n && !mine.some(isC)) {
    const top = avail.filter((id) => canTake(mine)(id)).sort((a, b) => rowOf.get(b)!.value - rowOf.get(a)!.value).slice(0, 16)
    const c = top.find(isC)
    if (c) return c
  }
  return app()(avail, mine, overall, slot)
}
const skipUnder = (games: number): Pick => (avail, mine, overall, slot) => {
  const ok = avail.filter((id) => (rowOf.get(id)?.games.gp ?? 0) >= games)
  return app()(ok.length ? ok : avail, mine, overall, slot)
}
const MODE = arg('mode') ?? 'center'
const cappedTeam = (n: number): Pick => (avail, mine, overall, slot) => {
  const teamOf = (id: string) => byId.get(id)!.team
  const ok = avail.filter((id) => mine.filter((m) => teamOf(m) === teamOf(id)).length < n)
  return app()(ok.length ? ok : avail, mine, overall, slot)
}
// A coin flip (within 1% of the top score, as the cards call it) goes to whoever shares no NBA team with my roster.
const mateBreak: Pick = (avail, mine, overall, slot) => {
  const pool = avail.map((id) => rowOf.get(id)!).filter(Boolean)
  const advice = advisePoints(pool, { teams: league.teams, rounds, slot, overall, spread: SPREAD }, 25, canTake(mine))
  if (!advice.length) return app()(avail, mine, overall, slot)
  const close = advice.filter((a) => advice[0].score - a.score <= Math.abs(advice[0].score) * 0.01).slice(0, 3)
  const teamOf = (id: string) => byId.get(id)!.team
  return (close.find((a) => !mine.some((m) => teamOf(m) === teamOf(a.id))) ?? close[0]).id
}
// The queue study: the queue built two picks out (off-clock cards, or unfiltered) against the advice on the clock.
const queueStats: { firstIsTop: boolean; inQueue: boolean; cost: number | null }[] = []
const queueStudy = (filtered: boolean, size: number): Pick => (avail, mine, overall, slot) => {
  const advise = (ids: string[], include: string[] = []) => advisePoints(ids.map((id) => rowOf.get(id)!).filter(Boolean), { teams: league.teams, rounds, slot, overall, spread: SPREAD }, 25, canTake(mine), include)
  const now = advise(avail)
  const before = new Set(history.slice(0, overall - 3))
  if (overall > 3 && now.length && !mine.some((m) => history.indexOf(m) >= overall - 3)) {
    const shown = advise(pool.filter((id) => !before.has(id) && (!filtered || survives(adp(id), overall, SPREAD) >= 0.5)))
    const queue = [...new Set([shown[0]?.id, shown[0]?.then, ...shown.slice(1).map((a) => a.id)].filter(Boolean) as string[])].slice(0, size)
    const first = queue.find((id) => avail.includes(id))
    const scored = first ? advise(avail, [first]) : now
    const fq = scored.find((a) => a.id === first)
    queueStats.push({ firstIsTop: first === scored[0].id, inQueue: queue.includes(scored[0].id), cost: fq ? (scored[0].score - fq.score) / Math.abs(scored[0].score) : null })
  }
  return now[0]?.id ?? app()(avail, mine, overall, slot)
}
const cMin = (n: number, by: number): Pick => (avail, mine, overall, slot) => {
  if (mine.filter(isC).length < n && mine.length + 1 >= by) {
    const top = avail.filter((id) => canTake(mine)(id)).sort((a, b) => rowOf.get(b)!.value - rowOf.get(a)!.value).slice(0, 16)
    const c = top.find(isC)
    if (c) return c
  }
  return app()(avail, mine, overall, slot)
}
const strategies: Record<string, Pick> = MODE === 'centers' ? {
  'the app (recommender)': app(),
  '2 C by my pick 5': cMin(2, 5),
  '2 C by my pick 7': cMin(2, 7),
  '2 C by my pick 9': cMin(2, 9),
} : MODE === 'survival' ? {
  'the app (recommender)': app(),
  'app, survival from ADP alone': app(undefined, false, true),
} : MODE === 'queue' ? {
  'the app (recommender)': queueStudy(!process.argv.includes('--unfiltered'), Number(process.argv[process.argv.indexOf('--queue-size') + 1]) || 3),
} : MODE === 'teammates' ? {
  'the app (recommender)': app(),
  'app, one per NBA team': cappedTeam(1),
  'app + teammate tiebreak': mateBreak,
} : MODE === 'turns' ? {
  'the app (recommender)': app(),
  'app, turns as before': app(undefined, true),
} : MODE === 'injured' ? {
  'the app (recommender)': app(),
  'app, no one under 25 games': skipUnder(25),
  'app, no one under 41 games': skipUnder(41),
  'app, no one under 55 games': skipUnder(55),
} : {
  'the app (recommender)': app(),
  'app, positional value': app(posValue),
  'a C by my pick 2': cBy(2),
  'a C by my pick 3': cBy(3),
  'a C by my pick 5': cBy(5),
}

// ── The room ──

function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
const pool = rows.filter((r) => r.adp < 400).map((r) => r.id)

let history: string[] = []
function draft(slot: number, seed: number, pick: Pick): string[][] {
  history = []
  const r = rng(seed * 7919 + slot)
  const scatter = new Map(pool.map((id) => [id, adp(id) + gauss(r) * (SPREAD.a + SPREAD.b * adp(id))]))
  const taken = new Set<string>()
  const teams: string[][] = Array.from({ length: league.teams }, () => [])
  const byScatter = (xs: string[]) => [...xs].sort((a, b) => scatter.get(a)! - scatter.get(b)!)
  for (let overall = 1; overall <= league.teams * rounds; overall++) {
    const seat = slotFor(overall, league.teams)
    const avail = pool.filter((id) => !taken.has(id))
    const id = seat === slot ? pick(avail, teams[seat - 1], overall, slot)
      : byScatter(avail.filter((x) => canTake(teams[seat - 1])(x) || never.has(x)))[0] ?? byScatter(avail)[0]
    taken.add(id)
    teams[seat - 1].push(id)
    history.push(id)
  }
  return teams
}

// ── Scoring: season fantasy points from starts, raced week by week ──

const cal = calendar(JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games)
const WEEKS = 23.4
function weeklyPoints(ids: string[]): number {
  const roster = ids.map((id) => ({ id, positions: seatPositions(posOf(id)), team: byId.get(id)!.team, worth: rowOf.get(id)?.fpg ?? 0 }))
  const share = startShares(roster, seats, cal)
  return ids.reduce((s, id) => { const r = rowOf.get(id); return s + (r ? r.fpg * r.games.gp * (share.get(id) ?? 1) : 0) }, 0) / WEEKS
}
function phi(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}
const edge = (a: number, b: number) => phi((a - b) / (Math.SQRT2 * POINTS_WEEK_CV * ((a + b) / 2)))

// ── Raw totals (--raw): weeks played out in box scores, scored the league's way, IL pickups included ──
const RAW = process.argv.includes('--raw')
const rawWeeks = weeksOf(scheduleGames, '2026-10-19', (league.playoffWeeks?.[0] ?? 20) - 1)
const playingOn = (() => {
  const m = new Map<string, Set<string>>()
  for (const g of scheduleGames) { const x = m.get(g.date) ?? new Set<string>(); x.add(g.home); x.add(g.away); m.set(g.date, x) }
  return (d: string) => m.get(d) ?? new Set<string>()
})()
const backOn = new Map<string, string>()
for (const [id, n] of injuryNotes) {
  if (n.outForSeason) { backOn.set(id, '2099-01-01'); continue }
  const t = new Date(n.returnDate + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 10); backOn.set(id, t.toISOString().slice(0, 10))
}
function seasonPlayer(id: string): SeasonPlayer {
  const p = byId.get(id)!
  const back = backOn.get(id) ?? null
  const avail = (teamDates[p.team ?? ''] ?? []).filter((d) => !back || d >= back).length || 80
  return { id, team: p.team, positions: seatPositions(posOf(id)), box: perGameBox(p), play: Math.min(0.97, (rowOf.get(id)?.games.gp ?? 0) / Math.max(1, avail)), worth: rowOf.get(id)?.fpg ?? 0, from: back }
}
function rawAllPlay(teams: string[][], seed: number): number[] {
  const drafted = new Set(teams.flat())
  const free = pool.filter((id) => !drafted.has(id) && !never.has(id) && !backOn.has(id)).sort((a, b) => rowOf.get(b)!.value - rowOf.get(a)!.value)
  const rosters = teams.map((t) => {
    const ps = t.map(seasonPlayer)
    // Two IL slots in Harker: each player out at the start is covered by a pickup until he is back.
    for (const p of ps.filter((x) => x.from && x.from > rawWeeks[0].dates[0]).slice(0, 2)) {
      const fa = free.shift()
      if (fa) ps.push({ ...seasonPlayer(fa), until: p.from })
    }
    return ps
  })
  const weeks = playSeason(rosters, rawWeeks, playingOn, seats, seasonRng(seed))
  const pts = weeks.map((tw) => tw.map((b) => pointsOf(b, league.points)))
  return pts.map((mine, i) => {
    let got = 0, n = 0
    for (let w = 0; w < mine.length; w++) for (let o = 0; o < pts.length; o++) {
      if (o === i) continue
      got += mine[w] > pts[o][w] ? 1 : mine[w] === pts[o][w] ? 0.5 : 0; n++
    }
    return got / n
  })
}

const res: Record<string, { ap: number[]; pts: number[]; c: number[] }> = {}
for (const [name, pick] of Object.entries(strategies)) {
  const r = { ap: [] as number[], pts: [] as number[], c: [] as number[] }
  // Turns only differ at the ends of the order: the first and last slots pick back to back.
  for (let slot = 1; slot <= league.teams; slot++) for (let seed = 1; seed <= SEEDS; seed++) {
    if (MODE === 'turns' && slot !== 1 && slot !== league.teams) continue
    const teams = draft(slot, seed, pick)
    const pts = teams.map(weeklyPoints)
    const me = pts[slot - 1]
    r.ap.push(RAW ? rawAllPlay(teams, seed * 7919 + slot)[slot - 1] : pts.filter((_, i) => i !== slot - 1).reduce((s, o) => s + edge(me, o), 0) / (league.teams - 1))
    r.pts.push(me)
    r.c.push(teams[slot - 1].findIndex(isC) + 1 || 99)
  }
  res[name] = r
  console.error(`${name}: done`)
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const se = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) }
const ref = res['the app (recommender)']
console.log(`Harker, 16 slots × ${SEEDS} rooms, room spread 1.5+0.10·ADP, ${RAW ? 'scored on RAW WEEKLY POINTS: box scores, daily lineups, real schedule, IL pickups, all-play' : 'scored on fantasy points from starts (7 seats, real schedule)'}.`)
console.log('strategy                  all-play   vs the app (paired) ±2se   pts/wk   first C at my pick (median)')
for (const [name, r] of Object.entries(res)) {
  const d = r.ap.map((x, i) => x - ref.ap[i])
  const cs = [...r.c].sort((a, b) => a - b)
  console.log(`${name.padEnd(25)} ${(mean(r.ap) * 100).toFixed(1).padStart(6)}%   ${(mean(d) * 100 >= 0 ? '+' : '') + (mean(d) * 100).toFixed(2)} ± ${(2 * se(d) * 100).toFixed(2)}     ${mean(r.pts).toFixed(0)}     ${cs[Math.floor(cs.length / 2)]}`)
}
if (MODE === 'queue' && queueStats.length) {
  const n = queueStats.length, costs = queueStats.map((q) => q.cost).filter((c): c is number => c != null)
  console.log(`queue study: ${n} turns; final top in queue ${(100 * queueStats.filter((q) => q.inQueue).length / n).toFixed(0)}%; first left in queue IS the final top ${(100 * queueStats.filter((q) => q.firstIsTop).length / n).toFixed(0)}%; mean cost ${(100 * costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(2)}% of the pick's score; over 1%: ${(100 * costs.filter((c) => c > 0.01).length / costs.length).toFixed(0)}%`)
}
