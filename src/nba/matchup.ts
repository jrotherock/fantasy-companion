/**
 * Where a head-to-head week stands and where it is going.
 *
 * What is banked is Yahoo's — the week's box so far for both sides. What is
 * still to come is the projection of each side's remaining daily lineups
 * (week.ts). Each category is then a race between two normal totals; the week
 * is the count of races won.
 *
 * Categories are treated as independent. They are not quite — points, makes
 * and threes move together — so the chance of the week is a little less
 * certain at the extremes than this says. The category chances themselves do
 * not depend on that.
 */
import { CATS, type Cat } from './value.js'
import { addBox, catsOf, emptyBox, type Box } from './yahooSeason.js'
import { DISPERSION } from './week.js'

export interface SideOutlook {
  /** The week so far. */
  now: Box
  /** Expected over the rest of the week, and its variance. */
  rest: Box
  restVar: Box
}

export interface CatRace {
  cat: Cat
  /** Where each side stands now, in the category's own units. */
  mineNow: number
  theirsNow: number
  /** Where each side is expected to finish. */
  mine: number
  theirs: number
  win: number
  tie: number
  /** Whether more games can still change it: a race 0.2–0.8 is in play. */
  state: 'safe' | 'leaning' | 'swing' | 'behind' | 'lost' | 'done'
}

function phi(z: number): number {
  // Abramowitz–Stegun 26.2.17, good to 1e-7.
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

const COUNTING: Record<Exclude<Cat, 'fg' | 'ft'>, keyof Box> = { tpm: 'tpm', pts: 'pts', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', to: 'to' }

/** Spread of a shooting percentage at the end of the week, from the shots still to come. */
function pctSd(now: Box, rest: Box, made: 'fgm' | 'ftm', att: 'fga' | 'fta'): number {
  const total = now[att] + rest[att]
  if (total <= 0 || rest[att] <= 0) return 0
  const p = (now[made] + rest[made]) / total
  return Math.sqrt(rest[att] * p * (1 - p) * DISPERSION[made]) / total
}

export function race(cat: Cat, a: SideOutlook, b: SideOutlook): CatRace {
  const nowA = catsOf(a.now), nowB = catsOf(b.now)
  const endA = catsOf(addBox(a.now, a.rest)), endB = catsOf(addBox(b.now, b.rest))
  let mean: number, sd: number, discrete: boolean
  if (cat === 'fg' || cat === 'ft') {
    const [m, t] = cat === 'fg' ? ['fgm', 'fga'] as const : ['ftm', 'fta'] as const
    mean = endA[cat] - endB[cat]
    sd = Math.hypot(pctSd(a.now, a.rest, m, t), pctSd(b.now, b.rest, m, t))
    discrete = false
    // A side with no shots at all cannot be compared until it has some.
    if (a.now[t] + a.rest[t] === 0 || b.now[t] + b.rest[t] === 0) { mean = 0; sd = 0 }
  } else {
    const k = COUNTING[cat]
    mean = endA[cat] - endB[cat]
    sd = Math.sqrt(a.restVar[k] + b.restVar[k])
    discrete = true
  }
  if (cat === 'to') mean = -mean
  let win: number, tie: number
  if (sd < 1e-9) {
    win = mean > 1e-9 ? 1 : mean < -1e-9 ? 0 : 0
    tie = Math.abs(mean) <= 1e-9 ? 1 : 0
  } else if (discrete) {
    win = 1 - phi((0.5 - mean) / sd)
    tie = phi((0.5 - mean) / sd) - phi((-0.5 - mean) / sd)
  } else {
    win = 1 - phi(-mean / sd)
    tie = 0
  }
  const left = sd > 1e-9
  const state: CatRace['state'] = !left ? 'done'
    : win >= 0.9 ? 'safe' : win >= 0.65 ? 'leaning' : win > 0.35 ? 'swing' : win > 0.1 ? 'behind' : 'lost'
  return { cat, mineNow: nowA[cat], theirsNow: nowB[cat], mine: endA[cat], theirs: endB[cat], win, tie, state }
}

export interface WeekOdds {
  races: CatRace[]
  /** Categories expected won, ties counting half. */
  expected: number
  /** The chance of winning, tying and losing the week. */
  win: number
  tie: number
  lose: number
}

/** The chance of taking more categories than the other side, from each race's odds. */
export function weekOdds(races: CatRace[]): WeekOdds {
  // Distribution of (won − lost), offset so index 0 is −n.
  const n = races.length
  let dist = new Array(2 * n + 1).fill(0)
  dist[n] = 1
  for (const r of races) {
    const lose = Math.max(0, 1 - r.win - r.tie)
    const next = new Array(2 * n + 1).fill(0)
    dist.forEach((p, i) => {
      if (!p) return
      if (i + 1 <= 2 * n) next[i + 1] += p * r.win
      next[i] += p * r.tie
      if (i - 1 >= 0) next[i - 1] += p * lose
    })
    dist = next
  }
  const win = dist.slice(n + 1).reduce((a, b) => a + b, 0)
  const tie = dist[n]
  return { races, expected: races.reduce((s, r) => s + r.win + r.tie / 2, 0), win, tie, lose: Math.max(0, 1 - win - tie) }
}

export function categoryWeek(a: SideOutlook, b: SideOutlook, cats: Cat[] = CATS): WeekOdds {
  return weekOdds(cats.map((c) => race(c, a, b)))
}

/** A points league's week: fantasy points from a box, at the league's weights. */
export type Weights = Partial<Record<'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'to' | 'tpm', number>>

export function pointsOf(b: Box, w: Weights): number {
  return (w.pts ?? 0) * b.pts + (w.reb ?? 0) * b.reb + (w.ast ?? 0) * b.ast + (w.stl ?? 0) * b.stl
    + (w.blk ?? 0) * b.blk + (w.to ?? 0) * b.to + (w.tpm ?? 0) * b.tpm
}

/**
 * Variance of fantasy points from the per-stat variances. Stats within a game
 * move together (a big night is big everywhere), so they are added as if
 * fully correlated within each game — the conservative end.
 */
export function pointsVar(v: Box, w: Weights): number {
  const sds = (['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'tpm'] as const).map((k) => Math.abs(w[k] ?? 0) * Math.sqrt(v[k]))
  // Fully correlated would be (Σ sd)²; independent Σ sd². Take the midpoint.
  const corr = sds.reduce((a, b) => a + b, 0) ** 2, ind = sds.reduce((a, b) => a + b * b, 0)
  return (corr + ind) / 2
}

export interface PointsOdds {
  mineNow: number; theirsNow: number
  mine: number; theirs: number
  win: number
}

export function pointsWeek(a: SideOutlook, b: SideOutlook, w: Weights, nowPoints?: { mine: number | null; theirs: number | null }): PointsOdds {
  // Yahoo's own total for the week so far beats re-adding the box, which can miss a stat it scores.
  const mineNow = nowPoints?.mine ?? pointsOf(a.now, w), theirsNow = nowPoints?.theirs ?? pointsOf(b.now, w)
  const mine = mineNow + pointsOf(a.rest, w), theirs = theirsNow + pointsOf(b.rest, w)
  const sd = Math.sqrt(pointsVar(a.restVar, w) + pointsVar(b.restVar, w))
  const win = sd < 1e-9 ? (mine > theirs ? 1 : mine < theirs ? 0 : 0.5) : 1 - phi((theirs - mine) / sd)
  return { mineNow, theirsNow, mine, theirs, win }
}

export const nothingYet = (): SideOutlook => ({ now: emptyBox(), rest: emptyBox(), restVar: emptyBox() })
