/**
 * A roster's typical week, and how it stands against another roster's.
 *
 * Used where a question is about the season rather than this week — a trade,
 * a pickup for the long run, how the room drafted. A typical week is each
 * player's per-game line times the games he is expected to play in a week,
 * with starts capped by the seats: a deep bench does not score.
 *
 * Head-to-head odds per category use the week-to-week spread measured on
 * Hoops 2025's real scoreboards (data/nba/category-noise.json, sdWeekly) —
 * the noise managers actually live with, streaming included.
 */
import { CATS, type Cat } from './value.js'
import { catsOf, emptyBox, type Box } from './yahooSeason.js'
import { pointsOf, type Weights } from './matchup.js'

/** A team plays about 3.5 games in a seven-day week (82 over 23.4 weeks). */
export const GAMES_PER_WEEK = 3.5

/**
 * Starts a week's seats hold. Hoops 2025 teams with eight starting seats
 * completed 33–35 games a week; the daily seat limit costs about half a game
 * per seat against a full seven days.
 */
export const STARTS_PER_SEAT = 4.3

export interface Member {
  id: string
  /** Expected per-game line. */
  box: Box
  /** Share of his team's games he is expected to play from here. */
  avail: number
  /** For ordering who takes the starts. */
  worth: number
}

/** The typical week: best players first, until the seats are full. */
export function typicalWeek(members: Member[], seats: number, gamesPerWeek = GAMES_PER_WEEK): { box: Box; starts: number } {
  let cap = seats * STARTS_PER_SEAT
  const box = emptyBox()
  let starts = 0
  for (const m of [...members].sort((a, b) => b.worth - a.worth)) {
    if (cap <= 0) break
    const g = Math.min(cap, gamesPerWeek * m.avail)
    for (const k of Object.keys(box) as (keyof Box)[]) box[k] += m.box[k] * g
    starts += g
    cap -= g
  }
  return { box, starts }
}

export interface Noise { sdWeekly: Record<Cat, number> }

function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

/** Chance a beats b in each category in a typical week. */
export function catEdges(a: Box, b: Box, noise: Noise, cats: Cat[] = CATS): Record<Cat, number> {
  const ca = catsOf(a), cb = catsOf(b)
  const out = {} as Record<Cat, number>
  for (const c of cats) {
    const diff = c === 'to' ? cb[c] - ca[c] : ca[c] - cb[c]
    out[c] = phi(diff / (Math.SQRT2 * noise.sdWeekly[c]))
  }
  return out
}

/** Categories a beats b in, expected, in a typical week. */
export function expectedCats(a: Box, b: Box, noise: Noise, cats: Cat[] = CATS): number {
  const e = catEdges(a, b, noise, cats)
  return cats.reduce((s, c) => s + e[c], 0)
}

/** Against every other team, averaged: what all-play would say for a typical week. */
export function catsVsLeague(mine: Box, others: Box[], noise: Noise, cats: Cat[] = CATS): number {
  if (!others.length) return 0
  return others.reduce((s, o) => s + expectedCats(mine, o, noise, cats), 0) / others.length
}

/**
 * A team's weekly fantasy points vary by about a ninth of their mean: the
 * games played swing by three or four a week, and each start is noisy. A
 * points week has no measured spread to borrow yet — Harker's scoreboards
 * would give one — so this is the stated estimate.
 */
export const POINTS_WEEK_CV = 0.11

export function pointsEdge(a: Box, b: Box, w: Weights): number {
  const pa = pointsOf(a, w), pb = pointsOf(b, w)
  const sd = Math.SQRT2 * POINTS_WEEK_CV * ((pa + pb) / 2)
  return sd > 0 ? phi((pa - pb) / sd) : 0.5
}

export function pointsVsLeague(mine: Box, others: Box[], w: Weights): number {
  if (!others.length) return 0.5
  return others.reduce((s, o) => s + pointsEdge(mine, o, w), 0) / others.length
}
