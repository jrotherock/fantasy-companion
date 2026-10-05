/**
 * The basketball draft recommender. One question per turn: given who is gone
 * and who I have, which pick now leaves me best off once my next turn has
 * come and gone?
 *
 * Two-step lookahead. A pick's score is what it gives now plus the expected
 * best I can still take next time, given who survives the picks in between.
 * That is what makes "he will still be there" count: a player the room will
 * leave alone is worth less now than his value says, because taking him spends
 * a pick on someone I could have had for free.
 *
 * Survival uses Yahoo's ADP, because the room drafts from Yahoo's queue. Where
 * Yahoo has no ADP for a player, his place in Yahoo's pre-draft order stands in
 * for it, since that order is what an autodrafting team takes.
 *
 * Points value is additive, so the points recommender sums value. Categories
 * are not: a fourth assist man is worth little to a team already winning
 * assists, and nothing to one already losing them badly. So the category
 * recommender scores a roster by the number of categories it expects to win
 * against an average team at the same stage of the draft, which is where
 * builds come from rather than from a list. Each category's weekly noise is
 * measured from the league's own last season (data/nba/category-noise.json).
 */
import { survival } from '../kernel/value.js'
import { nextPickFor } from '../kernel/snake.js'
import { CATS, TEAM_GAMES, type Cat, type CatRow } from './value.js'

export const DEFAULT_LATE_ADP = 400

export interface DraftSpot {
  teams: number
  rounds: number
  slot: number
  /** The overall pick about to be made, which is mine. */
  overall: number
  /** How far this league's picks land from ADP; football's measure when the league has none. */
  spread?: AdpSpread
}

/**
 * How far picks land from ADP: a standard deviation of a + b * ADP picks.
 * Football's measure (2 + 0.18 * ADP) was used for basketball until it was
 * checked against Hoops' own drafts — 1,559 picks over 12 seasons fit
 * 2 + 0.12 * ADP, and Harker's 735 picks 1.5 + 0.10 * ADP. Too wide a spread
 * makes every "gone by your next turn" too timid and every "can wait" too bold.
 */
export interface AdpSpread { a: number; b: number }
export const FOOTBALL_SPREAD: AdpSpread = { a: 2, b: 0.18 }

/** The chance a player is still there at pick `n`, with this league's spread. */
export function survives(adp: number, n: number, spread: AdpSpread = FOOTBALL_SPREAD): number {
  return survival(adp, n, Math.max(2, spread.a + spread.b * adp))
}

export interface Candidate {
  id: string
  name: string
  adp: number
}

/** Yahoo ADP where it exists, else Yahoo's queue position, else effectively undrafted. */
export function adpFor(p: { yahoo: { adp: number | null; rank: number } | null }): number {
  return p.yahoo?.adp ?? p.yahoo?.rank ?? DEFAULT_LATE_ADP
}

/**
 * Expected value of the best player still there at pick `next`, over a list
 * already sorted best first. Each one counts only if he survives and everyone
 * better does not. If nobody listed survives, `floor` is what is left.
 */
export function expectedBest(sorted: { value: number; adp: number }[], next: number, floor = 0, spread?: AdpSpread): number {
  let none = 1, e = 0
  for (const c of sorted) {
    const s = survives(c.adp, next, spread)
    e += c.value * s * none
    none *= 1 - s
    if (none < 1e-4) break
  }
  return e + floor * none
}

/**
 * Whether I would take this player now — or, with `after`, at my next turn
 * having taken `after` now. The never list and lineup feasibility live behind
 * it; the room's picks are not filtered by it.
 */
export type CanTake = (id: string, after?: string) => boolean
const anyone: CanTake = () => true

export interface Advice {
  id: string
  name: string
  /** What the pick is worth on its own. */
  now: number
  /** Now plus the expected best at my next turn. */
  score: number
  /** Chance he is still there at my next turn if I pass. */
  survives: number
}

function nextTurn(spot: DraftSpot): number | null {
  return nextPickFor(spot.slot, spot.teams, spot.rounds, spot.overall)
}

// ── Points ──────────────────────────────────────────────────────────────────

export function advisePoints(
  available: (Candidate & { value: number })[],
  spot: DraftSpot,
  shortlist = 25,
  canTake: CanTake = anyone,
): Advice[] {
  const next = nextTurn(spot)
  const sorted = [...available].sort((a, b) => b.value - a.value)
  const takeable: typeof sorted = []
  for (const c of sorted) {
    if (canTake(c.id)) takeable.push(c)
    if (takeable.length > shortlist + 40) break
  }
  return takeable.slice(0, shortlist).map((c) => {
    const rest = takeable.filter((x) => x.id !== c.id && canTake(x.id, c.id))
    const later = next == null ? 0 : expectedBest(rest, next, 0, spot.spread)
    return { id: c.id, name: c.name, now: c.value, score: c.value + later, survives: next == null ? 0 : survives(c.adp, next, spot.spread) }
  }).sort((a, b) => b.score - a.score)
}

// ── Categories ──────────────────────────────────────────────────────────────

export type Strength = Record<Cat, number>

/** A player's season contribution in each category: per-game z weighted by the share of games he plays. */
export function contribution(r: CatRow): Strength {
  const share = r.games.gp / TEAM_GAMES
  return Object.fromEntries(CATS.map((c) => [c, r.z[c] * share])) as Strength
}

const add = (a: Strength, b: Strength): Strength => Object.fromEntries(CATS.map((c) => [c, a[c] + b[c]])) as Strength
export const zero = (): Strength => Object.fromEntries(CATS.map((c) => [c, 0])) as Strength

/**
 * What an average team looks like after each number of picks, and how far
 * apart teams end up. Found by letting a whole league draft straight down
 * Yahoo's ADP, which is near enough how the room drafts.
 */
export interface Baseline {
  /** after[k] is the mean team strength after k picks. */
  after: Strength[]
  /** Noise of a head-to-head difference in strength units, per category. */
  sigma: Strength
}

export function baseline(rows: (CatRow & { adp: number })[], teams: number, rounds: number, r: Record<Cat, number>): Baseline {
  const order = [...rows].sort((a, b) => a.adp - b.adp)
  const strengths = Array.from({ length: teams }, () => zero())
  const after: Strength[] = [zero()]
  let i = 0
  for (let round = 1; round <= rounds; round++) {
    const seats = round % 2 === 1 ? [...Array(teams).keys()] : [...Array(teams).keys()].reverse()
    for (const t of seats) {
      const p = order[i++]
      if (p) strengths[t] = add(strengths[t], contribution(p))
    }
    after.push(Object.fromEntries(CATS.map((c) => [c, strengths.reduce((n, s) => n + s[c], 0) / teams])) as Strength)
  }
  const final = after[rounds]
  const sigma = Object.fromEntries(CATS.map((c) => {
    const sd = Math.sqrt(strengths.reduce((n, s) => n + (s[c] - final[c]) ** 2, 0) / teams)
    return [c, Math.max(1e-6, r[c] * sd)]
  })) as Strength
  return { after, sigma }
}

/** Abramowitz & Stegun 7.1.26. */
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a)
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a))
}
const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))

/** Chance of winning each category in a week against an average team with the same number of picks. */
export function winChances(mine: Strength, picks: number, base: Baseline): Strength {
  const avg = base.after[Math.min(picks, base.after.length - 1)]
  return Object.fromEntries(CATS.map((c) => [c, phi((mine[c] - avg[c]) / base.sigma[c])])) as Strength
}

/**
 * How many picks before a roster's shape says anything. Measured in mock drafts
 * from every slot of Hoops: the two weakest categories after k picks matched the
 * finished roster's about half the time for k of 1 to 3 (chance is about a
 * fifth), 80% at 4, 65-70% from 5 to 8 and 80-100% from 9. So nothing is read
 * before the fourth pick, a build is a leaning until the ninth, and firm after.
 */
export const BUILD_FROM = 4
export const BUILD_FIRM = 9

export type BuildRead = { stage: 'open' } | { stage: 'leaning' | 'firm'; punting: Cat[]; weakest: Cat[] }

export function readBuild(mine: Strength, picks: number, base: Baseline): BuildRead {
  if (picks < BUILD_FROM) return { stage: 'open' }
  const w = winChances(mine, picks, base)
  return {
    stage: picks < BUILD_FIRM ? 'leaning' : 'firm',
    punting: CATS.filter((c) => w[c] < 0.35),
    weakest: [...CATS].sort((a, b) => w[a] - w[b]).slice(0, 2),
  }
}

/** Categories expected to be won in a week, of those not given up. A locked punt is not counted at all. */
export function expectedCats(mine: Strength, picks: number, base: Baseline, ignore: Cat[] = []): number {
  const w = winChances(mine, picks, base)
  return CATS.reduce((n, c) => (ignore.includes(c) ? n : n + w[c]), 0)
}

export interface CategoryOptions {
  shortlist?: number
  lookahead?: number
  canTake?: CanTake
  /** Picks before which the roster's shape is read as an average team's. */
  neutralUntil?: number
  /** Categories locked as punts: no longer worth anything to the advice. */
  ignore?: Cat[]
  /**
   * A roster's strength counting only the games its players would start (starts.ts):
   * the sixth point guard adds little on nights the seats are full. Without it,
   * every drafted player's season counts in full.
   */
  strength?: (roster: CatRow[]) => Strength
}

export function adviseCategories(
  available: (CatRow & { adp: number })[],
  mine: CatRow[],
  spot: DraftSpot,
  base: Baseline,
  opts: CategoryOptions = {},
): Advice[] {
  const { shortlist = 20, lookahead = 40, canTake = anyone, neutralUntil = 0, ignore = [] } = opts
  const sum = (rs: CatRow[]) => rs.reduce((s, r) => add(s, contribution(r)), zero())
  const total = opts.strength ?? sum
  const next = nextTurn(spot)
  const k = mine.length
  // Before `neutralUntil` picks the roster's shape is not trusted to mean a
  // build: it is read as an average team's, so the advice is the best player
  // rather than the best fit for a direction one or two picks happened to set.
  // A punt the user has locked is honoured regardless — that is a decision, not a guess.
  const neutral = k < neutralUntil
  const have = neutral ? base.after[Math.min(k, base.after.length - 1)] : total(mine)
  const before = expectedCats(have, k, base, ignore)
  // With a roster read as it is, adding a player is scored on the roster's starts; read as an average team, simply added.
  const withOne = (c: CatRow) => (neutral || !opts.strength ? add(have, contribution(c)) : total([...mine, c]))
  const withTwo = (c: CatRow, x: CatRow, sc: Strength) => (neutral || !opts.strength ? add(sc, contribution(x)) : total([...mine, c, x]))

  // Score everyone (cheap), then ask whether I would take them only down the
  // list as far as the advice looks — the lineup check is the expensive part.
  const scored = available.map((c) => ({ c, s: withOne(c) }))
    .map(({ c, s }) => ({ c, s, e: expectedCats(s, k + 1, base, ignore) }))
    .sort((a, b) => b.e - a.e)
  const single: typeof scored = []
  for (const x of scored) {
    if (canTake(x.c.id)) single.push(x)
    if (single.length > Math.max(shortlist, lookahead)) break
  }

  return single.slice(0, shortlist).map(({ c, s, e }) => {
    let later = e
    if (next != null) {
      const follow = single.filter((x) => x.c.id !== c.id && canTake(x.c.id, c.id)).slice(0, lookahead)
        .map((x) => ({ value: expectedCats(withTwo(c, x.c, s), k + 2, base, ignore), adp: x.c.adp }))
        .sort((a, b) => b.value - a.value)
      later = expectedBest(follow, next, e, spot.spread)
    }
    return { id: c.id, name: c.name, now: e - before, score: later, survives: next == null ? 0 : survives(c.adp, next, spot.spread) }
  }).sort((a, b) => b.score - a.score)
}
