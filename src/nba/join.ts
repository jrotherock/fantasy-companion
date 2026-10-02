/**
 * Joins the basketball sources onto Sleeper's player list and derives the few
 * things every value model will need: a consensus per-game line, a projected
 * games-played figure, durability, and each team's schedule.
 *
 * Nothing here values a player. The consensus is a plain mean of the free
 * projection sets; how much a steal is worth is the value model's business.
 */
import { normaliseName } from '../kernel/match.js'
import type {
  Durability, Game, GpSource, LeagueRef, PerGame, Projection, Season, Shooting, SourceId,
  SourceLine, Team, TeamNote, TeamRow, YahooWeek,
} from './types.js'
import type { BrefTeam } from './sources.js'

const key = (name: string) => normaliseName(name)
const initialLast = (name: string) => {
  const parts = key(name).split(' ')
  return parts.length < 2 ? parts[0] ?? '' : `${parts[0][0]} ${parts[parts.length - 1]}`
}

export interface Candidate {
  id: string
  name: string
  team: Team | null
}

/**
 * Name first, team to break ties, then first-initial and surname with the team
 * required. Ambiguity resolves to null rather than to a guess.
 */
export class NameIndex {
  private exact = new Map<string, Candidate[]>()
  private initial = new Map<string, Candidate[]>()

  constructor(players: Candidate[]) {
    for (const p of players) {
      const add = (m: Map<string, Candidate[]>, k: string) => (m.get(k) ?? m.set(k, []).get(k)!).push(p)
      add(this.exact, key(p.name))
      add(this.initial, initialLast(p.name))
    }
  }

  resolve(name: string, team: Team | null): string | null {
    const pick = (pool: Candidate[], needTeam: boolean) => {
      const sameTeam = team ? pool.filter((p) => p.team === team) : []
      if (sameTeam.length === 1) return sameTeam[0].id
      if (!needTeam && pool.length === 1) return pool[0].id
      return null
    }
    return pick(this.exact.get(key(name)) ?? [], false) ?? pick(this.initial.get(initialLast(name)) ?? [], true)
  }
}

const STATS: (keyof PerGame)[] = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to']
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const meanOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null)
  return v.length ? mean(v) : null
}

/** Used when no source projects games and the player has no history: a rookie, usually. */
export const DEFAULT_GP = 65

/**
 * A plain mean across sources. Attempts come only from Sleeper; the
 * percentages are averaged as given, since each source's percentage is its own
 * view of the same shots.
 */
export function consensus(lines: SourceLine[], durability: Durability, teamGames = 82): Projection | null {
  if (!lines.length) return null
  const perGame = Object.fromEntries(STATS.map((s) => [s, mean(lines.map((l) => l.perGame[s]))])) as unknown as PerGame
  const shooting: Shooting = {
    fgPct: meanOf(lines.map((l) => l.shooting.fgPct)),
    ftPct: meanOf(lines.map((l) => l.shooting.ftPct)),
    fga: meanOf(lines.map((l) => l.shooting.fga)),
    fta: meanOf(lines.map((l) => l.shooting.fta)),
  }

  let gp: number, gpSource: GpSource
  const projected = meanOf(lines.map((l) => l.gp))
  if (projected != null) [gp, gpSource] = [projected, 'fantasypros']
  else if (durability.gpShare != null) [gp, gpSource] = [durability.gpShare * teamGames, 'history']
  else [gp, gpSource] = [DEFAULT_GP, 'default']

  return { perGame, shooting, gp, gpSource, sources: lines.map((l) => l.source) as SourceId[] }
}

/**
 * Share of team games played over the last three seasons, weighted 3-2-1 from
 * the newest. A season the player was in the league for but has no row in
 * counts as nought: that is a season lost to injury, which is the point.
 */
export function durability(history: Season[], yearsExp: number | null, lastSeason: number, teamGames = 82): Durability {
  const bySeason = new Map(history.map((s) => [s.season, s]))
  let weighted = 0, weights = 0, seasons = 0
  for (let i = 0; i < 3; i++) {
    const season = lastSeason - i
    const inLeague = bySeason.has(season) || (yearsExp != null && season > lastSeason - yearsExp)
    if (!inLeague) continue
    const w = 3 - i
    weighted += w * Math.min(1, (bySeason.get(season)?.gp ?? 0) / teamGames)
    weights += w
    seasons++
  }
  return { seasons, gpShare: weights ? weighted / weights : null }
}

const nextDay = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

export function teamRows(
  games: Game[], weeks: YahooWeek[], leagues: LeagueRef[], bref: BrefTeam[], notes: Record<Team, TeamNote[]>,
): TeamRow[] {
  const dates = new Map<Team, string[]>()
  for (const g of games) for (const t of [g.home, g.away]) (dates.get(t) ?? dates.set(t, []).get(t)!).push(g.date)
  const weekOf = (d: string) => weeks.find(([, from, to]) => d >= from && d <= to)?.[0] ?? null
  const ratings = new Map(bref.map((b) => [b.team, b]))

  return [...dates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([team, ds]) => {
    const sorted = [...ds].sort()
    const byWeek: Record<number, number> = {}
    for (const d of sorted) {
      const w = weekOf(d)
      if (w != null) byWeek[w] = (byWeek[w] ?? 0) + 1
    }
    let backToBacks = 0
    for (let i = 1; i < sorted.length; i++) if (sorted[i] === nextDay(sorted[i - 1])) backToBacks++
    const playoffGames = Object.fromEntries(leagues.map((l) => [l.id, l.playoffWeeks.reduce((n, w) => n + (byWeek[w] ?? 0), 0)]))
    const r = ratings.get(team)
    return {
      team, pace: r?.pace ?? null, offRtg: r?.offRtg ?? null, defRtg: r?.defRtg ?? null,
      games: sorted.length, backToBacks, byWeek, playoffGames, notes: notes[team] ?? [],
    }
  })
}

