/**
 * Does it pay, in Hoops, to cover the roster's weak categories with each pick,
 * to stack its strong ones, or to do a bit of both — or none of it, and take
 * the best player?
 *
 *   npx tsx scripts/nba-strategy-sim.ts [--seeds 20] [--window 4]
 *
 * Every strategy drafts from every slot against the same rooms: nine teams
 * drafting down Yahoo ADP with a realistic scatter, re-drawn identically for
 * each strategy so the comparisons are paired. My first pick is the best
 * value for all of them; from the second on, each strategy chooses among the
 * best few players by value (the window), so none can win by reaching.
 *
 * Scored on what wins a head-to-head league: the chance of winning a week
 * against each of the nine rosters actually drafted in that room (categories
 * raced with the week-to-week noise measured on Hoops 2025), averaged — an
 * all-play win rate. Expected categories a week against an average team is
 * reported beside it.
 */
import { readFileSync, existsSync } from 'node:fs'
import type { NbaPlayer } from '../src/nba/types.js'
import { categoryZ, rankBuild, rosterSpots, CATS, type Cat } from '../src/nba/value.js'
import { adpFor, adviseCategories, FOOTBALL_SPREAD, type AdpSpread, baseline, contribution, expectedCats, winChances, zero, BUILD_FROM, type Strength } from '../src/nba/draft.js'
import { positionalSlots, stillFeasible } from '../src/nba/lineup.js'
import { slotFor } from '../src/kernel/snake.js'
import { PATHS } from '../src/nba/plan.js'
import { calendar, startShares } from '../src/nba/starts.js'
import { startingSeats } from '../src/nba/week.js'
import { seatPositions } from '../src/nba/inseason.js'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null }
const SEEDS = Number(arg('seeds') ?? 20)
const WINDOW = Number(arg('window') ?? 4)
/** `--mode locks` compares when to lock a punt instead of how to choose for fit. */
const MODE = arg('mode') ?? 'fit'
/** `--first "Name"` takes that player with my first pick, from the slots where he is realistically there (`--slots 1-6`). */
const FIRST = arg('first')
const [SLOT_FROM, SLOT_TO] = (arg('slots') ?? '').split('-').map(Number)
/** `--room-spread 2,0.12`: how far the room strays from ADP (sd = a + b * ADP). Football's measure by default. */
const ROOM: AdpSpread = (() => { const [a, b] = (arg('room-spread') ?? '2,0.18').split(',').map(Number); return { a, b } })()

const players: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === 'nba-hoops')
const noiseR = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r as Record<Cat, number>
const rounds = rosterSpots(league.roster)
const byId = new Map(players.map((p) => [p.id, p]))
const adp = (id: string) => adpFor(byId.get(id)!)
const rows = categoryZ(players, league).map((r) => ({ ...r, adp: adp(r.id) }))
const rowOf = new Map(rows.map((r) => [r.id, r]))
const base = baseline(rows, league.teams, rounds, noiseR)
const value = new Map(rankBuild(rows, league, []).map((r) => [r.id, r.value]))
const contribOf = new Map(rows.map((r) => [r.id, contribution(r)]))

// His rule: never drafted. The local preferences file when there is one; else the three he named.
const neverNames = existsSync('data/preferences/nba.json')
  ? (JSON.parse(readFileSync('data/preferences/nba.json', 'utf8')).never ?? [])
  : ['Anthony Davis', 'Joel Embiid', 'Kristaps Porziņģis']
const never = new Set(players.filter((p) => neverNames.includes(p.name)).map((p) => p.id))

const slots = positionalSlots(league.roster)
const posOf = (id: string) => byId.get(id)!.yahoo?.positions ?? byId.get(id)!.positions
const canTake = (mine: string[]) => (id: string, after?: string) => {
  if (never.has(id)) return false
  const have = mine.map(posOf)
  const roster = after ? [...have, posOf(after)] : have
  return stillFeasible(roster, posOf(id), slots, rounds - roster.length - 1)
}

const strengthOf = (ids: string[]): Strength => ids.reduce((s, id) => {
  const c = contribOf.get(id)!
  return Object.fromEntries(CATS.map((k) => [k, s[k] + c[k]])) as Strength
}, zero())

// ── Lineup-aware scoring (--lineups): a player's season counts only on the nights he starts ──
const LINEUPS = process.argv.includes('--lineups')
const cal = calendar(JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games)
const seatsOf = startingSeats(league.roster)
const valueOrZero = (id: string) => value.get(id) ?? 0
function startedStrength(ids: string[]): Strength {
  const roster = ids.map((id) => ({ id, positions: seatPositions(posOf(id)), team: byId.get(id)!.team, worth: valueOrZero(id) }))
  const share = startShares(roster, seatsOf, cal)
  return ids.reduce((s, id) => {
    const c = contribOf.get(id)!, k = share.get(id) ?? 1
    return Object.fromEntries(CATS.map((x) => [x, s[x] + c[x] * k])) as Strength
  }, zero())
}
/** Starts lost over a roster: games its players' teams play that no seat holds, as a share of all their games. */
function idleShare(ids: string[]): number {
  const roster = ids.map((id) => ({ id, positions: seatPositions(posOf(id)), team: byId.get(id)!.team, worth: valueOrZero(id) }))
  const share = startShares(roster, seatsOf, cal)
  const w = ids.map((id) => (rowOf.get(id)?.games.gp ?? 0))
  const tot = w.reduce((a, b) => a + b, 0)
  return tot ? ids.reduce((s, id, i) => s + w[i] * (1 - (share.get(id) ?? 1)), 0) / tot : 0
}

// ── Strategies: each picks from the best WINDOW players by value ──

type Pick = (avail: string[], mine: string[], overall: number, slot: number, taken: Set<string>) => string
const windowOf = (avail: string[], mine: string[]) => {
  const ok = avail.filter((id) => canTake(mine)(id))
  return ok.sort((a, b) => value.get(b)! - value.get(a)!).slice(0, WINDOW)
}
const ranked = (mine: string[]) => {
  const w = winChances(strengthOf(mine), mine.length, base)
  return [...CATS].sort((a, b) => w[a] - w[b])
}
const gain = (id: string, cats: Cat[]) => cats.reduce((s, c) => s + Math.max(0, contribOf.get(id)![c]), 0)
const byScore = (ids: string[], f: (id: string) => number) => ids.reduce((x, y) => (f(y) > f(x) ? y : x))

const strategies: Record<string, Pick> = {
  'best value': (avail, mine) => windowOf(avail, mine)[0],
  'cover weak 3': (avail, mine) => mine.length ? byScore(windowOf(avail, mine), (id) => gain(id, ranked(mine).slice(0, 3))) : windowOf(avail, mine)[0],
  'stack strong 3': (avail, mine) => mine.length ? byScore(windowOf(avail, mine), (id) => gain(id, ranked(mine).slice(-3))) : windowOf(avail, mine)[0],
  'cover 2 + stack 2': (avail, mine) => mine.length ? byScore(windowOf(avail, mine), (id) => { const r = ranked(mine); return gain(id, r.slice(0, 2)) + gain(id, r.slice(-2)) }) : windowOf(avail, mine)[0],
  // Stack until the build is read (pick 4), then cover what is left in play: lean in early, round out late.
  'stack then cover': (avail, mine) => !mine.length ? windowOf(avail, mine)[0]
    : byScore(windowOf(avail, mine), (id) => gain(id, mine.length < BUILD_FROM ? ranked(mine).slice(-3) : ranked(mine).slice(2, 5))),
  'the app (recommender)': (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none'),
  'app + cover tiebreak': (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'cover'),
  'app + stack tiebreak': (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'stack'),
}

/** The app's advice, with near-ties (within 0.02 categories, as on the screen) broken by fit or not at all. */
function appPick(avail: string[], mine: string[], overall: number, slot: number, tie: 'none' | 'cover' | 'stack', locks: Cat[] = [], spread: AdpSpread = FOOTBALL_SPREAD, lineup = false): string {
  // As the app does: a lock drops the category and ends the four-pick wait.
  const advice = adviseCategories(avail.map((id) => rowOf.get(id)!).filter(Boolean), mine.map((id) => rowOf.get(id)!),
    { teams: league.teams, rounds, slot, overall, spread }, base, { canTake: canTake(mine), neutralUntil: locks.length ? 0 : BUILD_FROM, ignore: locks,
      strength: lineup ? (rs) => startedStrength(rs.map((r) => r.id)) : undefined })
  if (!advice.length) return windowOf(avail, mine)[0]
  if (tie === 'none' || !mine.length) return advice[0].id
  const close = advice.filter((a) => advice[0].score - a.score <= 0.02).slice(0, 3).map((a) => a.id)
  const r = ranked(mine)
  const cats = tie === 'cover' ? r.slice(0, 3) : r.slice(-3)
  return byScore(close, (id) => gain(id, cats))
}

// ── The room: Yahoo ADP with scatter ──

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())

const pool = rows.filter((r) => r.adp < 400).map((r) => r.id)

function draft(slot: number, seed: number, pick: Pick): { mine: string[]; teams: string[][] } {
  const r = rng(seed * 7919 + slot)
  // Each team's view of every player, drawn once per room: same room for every strategy.
  const scatter = new Map(pool.map((id) => [id, adp(id) + gauss(r) * (ROOM.a + ROOM.b * adp(id))]))
  const taken = new Set<string>()
  const teams: string[][] = Array.from({ length: league.teams }, () => [])
  for (let overall = 1; overall <= league.teams * rounds; overall++) {
    const seat = slotFor(overall, league.teams)
    const avail = pool.filter((id) => !taken.has(id))
    let id: string
    const byScatter = (xs: string[]) => [...xs].sort((a, b) => scatter.get(a)! - scatter.get(b)!)
    const firstId = FIRST ? players.find((p) => p.name === FIRST)?.id : undefined
    if (seat === slot && firstId && teams[seat - 1].length === 0 && avail.includes(firstId)) id = firstId
    else if (seat === slot) id = pick(avail, teams[seat - 1], overall, slot, taken) ?? byScatter(avail)[0]
    else {
      const ok = canTake(teams[seat - 1])
      // A roster whose seats nobody left can fill takes the best player anyway, as a manager would.
      id = byScatter(avail.filter((x) => ok(x) || never.has(x)))[0] ?? byScatter(avail)[0]
    }
    taken.add(id)
    teams[seat - 1].push(id)
  }
  return { mine: teams[slot - 1], teams }
}

// ── Scoring: head-to-head weeks against the nine rosters in the room ──

function phi(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}
function weekWin(a: Strength, b: Strength): number {
  // Chance of more categories than the other side, each a race with Hoops' measured noise.
  const ps = CATS.map((c) => phi((a[c] - b[c]) / base.sigma[c]))
  let dist = new Map<number, number>([[0, 1]])
  for (const p of ps) {
    const next = new Map<number, number>()
    for (const [k, v] of dist) {
      next.set(k + 1, (next.get(k + 1) ?? 0) + v * p)
      next.set(k - 1, (next.get(k - 1) ?? 0) + v * (1 - p))
    }
    dist = next
  }
  let win = 0
  for (const [k, v] of dist) if (k > 0) win += v
  return win
}

// ── Lock timing ──
//
// A lock is decided from the roster as it stands, so it can be worked out from
// the picks so far every time: the same roster always gives the same lock.

const weakest = (ids: string[], n: number) => (ids.length ? ranked(ids).slice(0, n) : [])

/** Lock my n weakest categories as they stood just before my k-th pick, and keep them. */
const lockAt = (k: number, n: number): Pick => (avail, mine, overall, slot) =>
  appPick(avail, mine, overall, slot, 'none', mine.length >= k - 1 && k > 1 ? weakest(mine.slice(0, k - 1), n) : [])

/** From the fifth pick, lock the weakest category once it has been the weakest two picks running. */
const lockWhenStable: Pick = (avail, mine, overall, slot) => {
  let locks: Cat[] = []
  for (let k = BUILD_FROM; k <= mine.length; k++) {
    const a = weakest(mine.slice(0, k - 1), 1)[0], b = weakest(mine.slice(0, k), 1)[0]
    if (k > BUILD_FROM && a && a === b) { locks = [a]; break }
  }
  return appPick(avail, mine, overall, slot, 'none', locks)
}

// Each player's rank in each build, to know who is drafted for a punt.
const buildRanks = PATHS.map((path) => ({ path, rank: new Map(rankBuild(rows, league, path.punt).map((r) => [r.id, r.rank])) }))
/** The build a pick is drafted for, as the app's lock offer works it out; null for an ordinary pick. */
function anchorBuild(id: string): Cat[] | null {
  const balanced = buildRanks[0].rank.get(id)
  if (balanced == null) return null
  const opts = buildRanks.slice(1).map((b) => ({ punt: b.path.punt, rank: b.rank.get(id) ?? 999 }))
  const best = Math.min(...opts.map((o) => o.rank))
  if (balanced - best < 20 || best > 150) return null
  return opts.filter((o) => o.rank <= best + 5).sort((x, y) => x.punt.length - y.punt.length || x.rank - y.rank)[0].punt
}
/** Accept the lock offer the first time a pick is drafted for a punt. */
const lockOnAnchor: Pick = (avail, mine, overall, slot) => {
  let locks: Cat[] = []
  for (const id of mine) { const b = anchorBuild(id); if (b) { locks = b; break } }
  return appPick(avail, mine, overall, slot, 'none', locks)
}

if (MODE === 'first') {
  // After a forced first pick: the advice as it is, against locking that player's punt now or at the fourth pick.
  for (const k of Object.keys(strategies)) delete strategies[k]
  const punt = (arg('punt') ?? 'ft').split('+') as Cat[]
  strategies['the app (recommender)'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none')
  strategies[`lock ${punt.join('+')} at once`] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', mine.length >= 1 ? punt : [])
  strategies[`lock ${punt.join('+')} at pick 4`] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', mine.length >= 3 ? punt : [])
  strategies['best value'] = (avail, mine) => windowOf(avail, mine)[0]
}

if (MODE === 'lineup') {
  for (const k of Object.keys(strategies)) delete strategies[k]
  strategies['best value'] = (avail, mine) => windowOf(avail, mine)[0]
  strategies['the app (recommender)'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', [], { a: 2, b: 0.12 })
  strategies['app, counting starts'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', [], { a: 2, b: 0.12 }, true)
}

if (MODE === 'spread') {
  // The app assuming football's spread, against the app assuming the spread measured in Hoops' drafts.
  for (const k of Object.keys(strategies)) delete strategies[k]
  strategies['best value'] = (avail, mine) => windowOf(avail, mine)[0]
  strategies['the app (recommender)'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none')
  strategies['app, Hoops spread 2+0.12'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', [], { a: 2, b: 0.12 })
  strategies['app, tight spread 2+0.08'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none', [], { a: 2, b: 0.08 })
}

if (MODE === 'locks') {
  for (const k of Object.keys(strategies)) delete strategies[k]
  strategies['best value'] = (avail, mine) => windowOf(avail, mine)[0]
  strategies['the app (recommender)'] = (avail, mine, overall, slot) => appPick(avail, mine, overall, slot, 'none')
  for (const k of [2, 3, 4, 5, 6, 8, 10]) strategies[`lock weakest at pick ${k}`] = lockAt(k, 1)
  for (const k of [4, 6]) strategies[`lock 2 weakest at pick ${k}`] = lockAt(k, 2)
  strategies['lock when stable (5+)'] = lockWhenStable
  strategies['lock on anchor'] = lockOnAnchor
}

const results: Record<string, { allPlay: number[]; cats: number[]; bySlot: number[][]; idle: number[] }> = {}
const t0 = Date.now()
for (const [name, pick] of Object.entries(strategies)) {
  const res = { allPlay: [] as number[], cats: [] as number[], bySlot: Array.from({ length: league.teams }, () => [] as number[]), idle: [] as number[] }
  for (let slot = SLOT_FROM || 1; slot <= (SLOT_TO || league.teams); slot++) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { mine, teams } = draft(slot, seed, pick)
      const score = LINEUPS ? startedStrength : strengthOf
      const me = score(mine)
      const others = teams.filter((_, i) => i !== slot - 1).map(score)
      res.idle.push(idleShare(mine))
      const ap = others.reduce((s, o) => s + weekWin(me, o), 0) / others.length
      res.allPlay.push(ap)
      res.cats.push(expectedCats(me, mine.length, base))
      res.bySlot[slot - 1].push(ap)
    }
  }
  results[name] = res
  console.error(`${name}: done (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const se = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) }
const ref = results['best value'].allPlay
console.log(`Hoops, slots ${SLOT_FROM || 1}–${SLOT_TO || league.teams} × ${SEEDS} rooms each, window ${WINDOW}, room spread ${ROOM.a}+${ROOM.b}·ADP${FIRST ? `, first pick ${FIRST}` : ''}. All-play = chance of winning a week, averaged over the nine rosters in the room.`)
console.log(`${LINEUPS ? 'Scored on starts only (daily lineups, Hoops seats, real schedule). ' : ''}idle = share of my players' games with no seat.`)
console.log('strategy                 all-play   ±2se    vs best value (paired) ±2se    cats/wk   idle')
for (const [name, r] of Object.entries(results)) {
  const diff = r.allPlay.map((x, i) => x - ref[i])
  console.log(`${name.padEnd(24)} ${(mean(r.allPlay) * 100).toFixed(1).padStart(6)}%  ${(2 * se(r.allPlay) * 100).toFixed(1).padStart(4)}   ${(mean(diff) * 100 >= 0 ? '+' : '') + (mean(diff) * 100).toFixed(1).padStart(5)} pts  ${(2 * se(diff) * 100).toFixed(1).padStart(4)}       ${mean(r.cats).toFixed(2)}   ${(mean(r.idle) * 100).toFixed(1)}%`)
}
const app = results['the app (recommender)'].allPlay
for (const name of Object.keys(results).filter((n) => n !== 'the app (recommender)' && n !== 'best value' && (MODE !== 'fit' || n.startsWith('app +')))) {
  const d = results[name].allPlay.map((x, i) => x - app[i])
  console.log(`${name} vs the app: ${(mean(d) * 100).toFixed(2)} pts ± ${(2 * se(d) * 100).toFixed(2)} (2se); changed the pick in ${d.filter((x) => x !== 0).length} of ${d.length} drafts`)
}
console.log('\nby slot (all-play %):')
console.log('slot  ' + Object.keys(results).map((n) => n.slice(0, 12).padStart(13)).join(''))
for (let s = 0; s < league.teams; s++) if (Object.values(results)[0].bySlot[s].length) console.log(String(s + 1).padStart(4) + '  ' + Object.values(results).map((r) => (mean(r.bySlot[s]) * 100).toFixed(1).padStart(13)).join(''))
