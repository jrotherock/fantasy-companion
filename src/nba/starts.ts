/**
 * How often each player on a roster actually starts.
 *
 * Basketball lineups are daily, and only the starting seats score. Five point
 * guards and no center is a fine-looking roster on paper; on a night they all
 * play, the PG seat and the Utils take four of them and the fifth sits, while
 * the C seat goes empty. In 9-cat a position scores nothing by itself, so the
 * only honest way to price "positional need" is in starts: what share of the
 * games a player's team plays does he get a seat for, given everyone else.
 *
 * Seated by worth each day (week.ts's seating, exact for this problem), over a
 * sample of the season's dates — every fourth day keeps every weekday and the
 * busy and quiet nights in proportion, at a quarter of the cost.
 */
import { seat } from './week.js'

export interface Rostered {
  id: string
  /** Seat positions (PG, SG, SF, PF, C; G/F already expanded). */
  positions: string[]
  team: string | null
  /** For ordering who sits: per-game worth. */
  worth: number
}

export interface Calendar {
  /** For each sampled date, the teams that play. */
  days: Set<string>[]
}

export function calendar(games: { date: string; home: string; away: string }[], every = 4): Calendar {
  const byDate = new Map<string, Set<string>>()
  for (const g of games) {
    const s = byDate.get(g.date) ?? new Set<string>()
    s.add(g.home); s.add(g.away)
    byDate.set(g.date, s)
  }
  const dates = [...byDate.keys()].sort()
  return { days: dates.filter((_, i) => i % every === 0).map((d) => byDate.get(d)!) }
}

/**
 * Each player's share of his team's games in which he starts, 0 to 1. A player
 * whose team never plays in the sample gets 1 (no evidence he would sit).
 */
export function startShares(roster: Rostered[], seats: string[], cal: Calendar): Map<string, number> {
  const games = new Map<string, number>(), starts = new Map<string, number>()
  for (const day of cal.days) {
    const playing = roster.filter((r) => r.team && day.has(r.team))
    if (!playing.length) continue
    const seated = seat(playing.map((r) => r.positions), playing.map((r) => r.worth), seats)
    const on = new Set([...seated.values()].map((i) => playing[i].id))
    for (const r of playing) {
      games.set(r.id, (games.get(r.id) ?? 0) + 1)
      if (on.has(r.id)) starts.set(r.id, (starts.get(r.id) ?? 0) + 1)
    }
  }
  return new Map(roster.map((r) => [r.id, games.get(r.id) ? (starts.get(r.id) ?? 0) / games.get(r.id)! : 1]))
}
