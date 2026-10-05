/**
 * A season played out in box scores, for judging drafts the way Yahoo judges
 * weeks — independently of the z-scores the advice reasons in.
 *
 * Every day of every week, each team seats its best available players in its
 * starting seats; each who plays puts up a game drawn around his per-game
 * line. A week's totals are summed; FG% and FT% are makes over attempts, so a
 * volume shooter weighs what he weighs in Yahoo. Each week every roster meets
 * every other in the nine categories (fewer turnovers wins), and all-play is
 * the share of those meetings won, ties counting half.
 *
 * Injuries are played, not discounted: a player hurt at the start sits until
 * his return date, and his team starts a free agent in his place until then —
 * the IL pickup every manager makes. Extra games are extra stats here, which
 * is the thing a sum of z-scores cannot say.
 */
import { seat } from './week.js'
import { emptyBox, type Box } from './yahooSeason.js'
import { DISPERSION } from './week.js'
import { CATS, type Cat } from './value.js'

export interface SeasonPlayer {
  id: string
  team: string | null
  /** Seat positions (PG SG SF PF C). */
  positions: string[]
  /** His expected line in a game he plays. */
  box: Box
  /** Chance he plays a team game once he is healthy. */
  play: number
  /** For choosing who starts on a crowded night. */
  worth: number
  /** Plays only from this date on (back from injury). */
  from?: string | null
  /** Plays only before this date (an IL pickup, until the player he covers returns). */
  until?: string | null
}

export interface SeasonWeek { dates: string[] }

export type Rng = () => number
export function rng(seed: number): Rng {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}
function gauss(r: Rng): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
}

/** One game around a player's line: counting stats overdispersed, makes drawn from attempts. */
export function playGame(b: Box, r: Rng): Box {
  const out = emptyBox()
  for (const k of ['tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'] as const) {
    out[k] = Math.max(0, b[k] + Math.sqrt(DISPERSION[k] * Math.max(b[k], 0.01)) * gauss(r))
  }
  const shots = (made: 'fgm' | 'ftm', att: 'fga' | 'fta') => {
    const a = Math.max(0, b[att] + Math.sqrt(DISPERSION[att] * Math.max(b[att], 0.01)) * gauss(r))
    const p = b[att] > 0 ? b[made] / b[att] : 0
    out[att] = a
    out[made] = Math.min(a, Math.max(0, a * p + Math.sqrt(a * p * (1 - p)) * gauss(r)))
  }
  shots('fgm', 'fga'); shots('ftm', 'fta')
  return out
}

/** Each team's box totals for each week. */
export function playSeason(teams: SeasonPlayer[][], weeks: SeasonWeek[], playing: (date: string) => Set<string>, seats: string[], r: Rng): Box[][] {
  return teams.map((roster) => weeks.map((w) => {
    const tot = emptyBox()
    for (const date of w.dates) {
      const teamsOn = playing(date)
      const avail = roster.filter((p) => p.team && teamsOn.has(p.team)
        && (!p.from || date >= p.from) && (!p.until || date < p.until)
        && r() < p.play)
      if (!avail.length) continue
      const seated = seat(avail.map((p) => p.positions), avail.map((p) => p.worth), seats)
      for (const i of seated.values()) {
        const g = playGame(avail[i].box, r)
        for (const k of Object.keys(tot) as (keyof Box)[]) tot[k] += g[k]
      }
    }
    return tot
  }))
}

/** Categories a beats b in, and loses, over one week's totals. */
export function weekResult(a: Box, b: Box, cats: Cat[] = CATS): { won: number; lost: number } {
  const v = (x: Box, c: Cat) => (c === 'fg' ? (x.fga ? x.fgm / x.fga : 0) : c === 'ft' ? (x.fta ? x.ftm / x.fta : 0) : x[c])
  let won = 0, lost = 0
  for (const c of cats) {
    const d = c === 'to' ? v(b, c) - v(a, c) : v(a, c) - v(b, c)
    if (d > 1e-9) won++
    else if (d < -1e-9) lost++
  }
  return { won, lost }
}

/** One team's all-play over the season: every week, against every other team, ties half. */
export function allPlayOf(weeks: Box[][], team: number): number {
  let got = 0, n = 0
  for (let w = 0; w < weeks[team].length; w++) {
    for (let o = 0; o < weeks.length; o++) {
      if (o === team) continue
      const r = weekResult(weeks[team][w], weeks[o][w])
      got += r.won > r.lost ? 1 : r.won === r.lost ? 0.5 : 0
      n++
    }
  }
  return n ? got / n : 0
}

/** Yahoo's weeks over a schedule: Monday to Sunday, the first from the opener. */
export function weeksOf(games: { date: string }[], first: string, count: number): SeasonWeek[] {
  const dates = [...new Set(games.map((g) => g.date))].sort()
  const start = Date.parse(first + 'T12:00:00Z')
  const out: SeasonWeek[] = Array.from({ length: count }, () => ({ dates: [] }))
  for (const d of dates) {
    const i = Math.floor((Date.parse(d + 'T12:00:00Z') - start) / (7 * 86400000))
    if (i >= 0 && i < count) out[i].dates.push(d)
  }
  return out
}
