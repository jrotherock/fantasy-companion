/**
 * The rest of a fantasy week, day by day.
 *
 * Basketball lineups are daily: each day only the players whose teams play can
 * score, and only as many of them as there are starting seats. A roster with
 * six guards on a nine-game night still starts one point guard. So a week's
 * projection is a lineup per remaining day — the best players playing that
 * day, seated so the most of them start — and the sum of what they are
 * expected to do.
 *
 * Seating is a weighted bipartite problem, but players-to-seats with
 * eligibility is a transversal matroid, so taking players in order of worth
 * and keeping each one the seats can still absorb is exactly optimal.
 */
import { addBox, emptyBox, type Box } from './yahooSeason.js'

/** What each starting seat takes. Bench and injured-list seats are not starting seats. */
export const ACCEPTS: Record<string, string[] | null> = {
  PG: ['PG'], SG: ['SG'], SF: ['SF'], PF: ['PF'], C: ['C'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], Util: null,
}

export const isStartingSeat = (slot: string) => slot in ACCEPTS

/** The starting seats a league's roster settings describe, one entry per seat. */
export function startingSeats(roster: Record<string, number>): string[] {
  return Object.entries(roster).flatMap(([slot, n]) => (isStartingSeat(slot) ? Array(n).fill(slot) : []))
}

const fits = (positions: string[], seat: string) => {
  const a = ACCEPTS[seat]
  return a == null ? true : positions.some((p) => a.includes(p))
}

/**
 * The best lineup from the players available: each player at most one seat,
 * the most worth seated. Returns seat index → player index.
 */
export function seat(positions: string[][], worth: number[], seats: string[]): Map<number, number> {
  const order = positions.map((_, i) => i).sort((a, b) => worth[b] - worth[a])
  const seatOf: (number | null)[] = seats.map(() => null)
  const tryPlace = (p: number, seen: boolean[]): boolean => {
    for (let s = 0; s < seats.length; s++) {
      if (seen[s] || !fits(positions[p], seats[s])) continue
      seen[s] = true
      if (seatOf[s] == null || tryPlace(seatOf[s]!, seen)) { seatOf[s] = p; return true }
    }
    return false
  }
  // A failed search changes nothing: a seat is only reassigned on the way back from a success.
  for (const p of order) tryPlace(p, seats.map(() => false))
  const out = new Map<number, number>()
  seatOf.forEach((p, s) => { if (p != null) out.set(s, p) })
  return out
}

export interface Man {
  id: string
  name: string
  /** Yahoo's eligible positions; Util and G/F entries are harmless. */
  positions: string[]
  team: string | null
}

/** A player's expected line in one game, if he plays, and the chance that he does. */
export interface GameOutlook { box: Box; play: number }

export interface WeekInput {
  men: Man[]
  seats: string[]
  /** The days still to play, in order: today first if it has games left. */
  days: string[]
  /** Teams with a game still to tip on each day. */
  playing: (date: string) => Set<string>
  outlook: (id: string, date: string) => GameOutlook | null
  /** One number for ranking who starts: per-game worth in this league's terms. */
  worth: (id: string) => number
  /** Players who cannot be moved today — already locked into, or out of, a seat. Today's lineup as set. */
  lockedToday?: { starting: Set<string> } | null
}

export interface DayPlan { date: string; starting: string[]; idle: string[] }

export interface WeekOutlook {
  /** Expected box over the remaining days, starters only. */
  box: Box
  /** Variance of each stat over the remaining days. */
  variance: Box
  /** Expected starts. */
  starts: number
  /** Player-games that fall on a day with no seat for them. */
  wasted: number
  days: DayPlan[]
  perMan: Map<string, { games: number; starts: number }>
}

/**
 * How noisy a stat is from game to game, as variance over mean. Counting stats
 * in basketball are overdispersed relative to Poisson: a 20-point scorer's
 * game-to-game spread is about 7, so variance ≈ 2.5× the mean.
 */
export const DISPERSION: Record<keyof Box, number> = {
  fgm: 1.3, fga: 1.3, ftm: 1.5, fta: 1.5, tpm: 1.3, pts: 2.5, reb: 1.6, ast: 1.6, stl: 1.1, blk: 1.4, to: 1.2,
}

export function projectWeek(w: WeekInput): WeekOutlook {
  let box = emptyBox(), variance = emptyBox(), starts = 0, wasted = 0
  const perMan = new Map(w.men.map((m) => [m.id, { games: 0, starts: 0 }]))
  const days: DayPlan[] = []
  w.days.forEach((date, di) => {
    const teams = w.playing(date)
    const live = w.men
      .map((m) => ({ m, o: m.team && teams.has(m.team) ? w.outlook(m.id, date) : null }))
      .filter((x) => x.o && x.o.play > 0)
    let chosen: Set<string>
    if (di === 0 && w.lockedToday) {
      chosen = new Set(live.filter((x) => w.lockedToday!.starting.has(x.m.id)).map((x) => x.m.id))
    } else {
      const seated = seat(live.map((x) => x.m.positions), live.map((x) => w.worth(x.m.id) * x.o!.play), w.seats)
      chosen = new Set([...seated.values()].map((i) => live[i].m.id))
    }
    for (const { m, o } of live) {
      const pm = perMan.get(m.id)!
      pm.games += o!.play
      if (!chosen.has(m.id)) { wasted += o!.play; continue }
      pm.starts += o!.play
      starts += o!.play
      box = addBox(box, o!.box, o!.play)
      for (const k of Object.keys(variance) as (keyof Box)[]) {
        const mean = o!.box[k]
        // Game-to-game noise when he plays, plus the chance he does not.
        variance[k] += o!.play * DISPERSION[k] * mean + o!.play * (1 - o!.play) * mean * mean
      }
    }
    days.push({ date, starting: [...chosen], idle: live.filter((x) => !chosen.has(x.m.id)).map((x) => x.m.id) })
  })
  return { box, variance, starts, wasted, days, perMan }
}

/** The days of a week from a given day on, inclusive. */
export function daysFrom(start: string, end: string, from: string): string[] {
  const out: string[] = []
  const first = from > start ? from : start
  for (let d = new Date(first + 'T12:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    if (iso > end) break
    out.push(iso)
  }
  return out
}
