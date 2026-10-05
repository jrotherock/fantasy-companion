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
import { adpFor, advisePoints } from '../src/nba/draft.js'
import { positionalSlots, stillFeasible } from '../src/nba/lineup.js'
import { slotFor } from '../src/kernel/snake.js'
import { calendar, startShares } from '../src/nba/starts.js'
import { startingSeats } from '../src/nba/week.js'
import { seatPositions } from '../src/nba/inseason.js'
import { POINTS_WEEK_CV } from '../src/nba/strength.js'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null }
const SEEDS = Number(arg('seeds') ?? 20)
const SPREAD = { a: 1.5, b: 0.1 }

const players: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
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
const app = (vals?: Map<string, number>): Pick => (avail, mine, overall, slot) => {
  const pool = avail.map((id) => rowOf.get(id)!).filter(Boolean).map((r) => (vals ? { ...r, value: vals.get(r.id) ?? r.value } : r))
  const advice = advisePoints(pool, { teams: league.teams, rounds, slot, overall, spread: SPREAD }, 25, canTake(mine))
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
const strategies: Record<string, Pick> = {
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

function draft(slot: number, seed: number, pick: Pick): string[][] {
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

const res: Record<string, { ap: number[]; pts: number[]; c: number[] }> = {}
for (const [name, pick] of Object.entries(strategies)) {
  const r = { ap: [] as number[], pts: [] as number[], c: [] as number[] }
  for (let slot = 1; slot <= league.teams; slot++) for (let seed = 1; seed <= SEEDS; seed++) {
    const teams = draft(slot, seed, pick)
    const pts = teams.map(weeklyPoints)
    const me = pts[slot - 1]
    r.ap.push(pts.filter((_, i) => i !== slot - 1).reduce((s, o) => s + edge(me, o), 0) / (league.teams - 1))
    r.pts.push(me)
    r.c.push(teams[slot - 1].findIndex(isC) + 1 || 99)
  }
  res[name] = r
  console.error(`${name}: done`)
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const se = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) }
const ref = res['the app (recommender)']
console.log(`Harker, 16 slots × ${SEEDS} rooms, room spread 1.5+0.10·ADP, scored on fantasy points from starts (7 seats, real schedule).`)
console.log('strategy                  all-play   vs the app (paired) ±2se   pts/wk   first C at my pick (median)')
for (const [name, r] of Object.entries(res)) {
  const d = r.ap.map((x, i) => x - ref.ap[i])
  const cs = [...r.c].sort((a, b) => a - b)
  console.log(`${name.padEnd(25)} ${(mean(r.ap) * 100).toFixed(1).padStart(6)}%   ${(mean(d) * 100 >= 0 ? '+' : '') + (mean(d) * 100).toFixed(2)} ± ${(2 * se(d) * 100).toFixed(2)}     ${mean(r.pts).toFixed(0)}     ${cs[Math.floor(cs.length / 2)]}`)
}
