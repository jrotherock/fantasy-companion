/**
 * A rank for every player in a league, the way Basketball Monster ranks them (Josh Lloyd leads its projections;
 * 2026-11-16: "I can't trust the Rank in Yahoo"): per game, each category a z-score against the players this league
 * actually rosters, the two percentages weighted by attempts, turnovers counted against; a points league by fantasy
 * points a game. Yahoo ranks by season totals with its own weights, so a player who missed a week sinks there and a
 * low-percentage volume shooter rises.
 *
 * Four windows (2026-11-16: "7 day, 30 day, season"): the last 7 and 30 days and the season to date from the games
 * played, and the rest of the season from the companion's own line (the projection with his form blended in), which
 * is what every move is judged on. A categories league also ranks each under my punts: the build I play.
 *
 * Shown, and used to find players worth a look; a move is still decided by the weeks it wins.
 */
import type { NbaPlayer } from './types.js'
import type { GameLog } from './outlook.js'
import { CATS, categoryZ, type Cat } from './value.js'
import { emptyBox, type Box } from './yahooSeason.js'

export type RankWindow = 'd7' | 'd30' | 'season' | 'ros'
export const WINDOWS: RankWindow[] = ['d7', 'd30', 'season', 'ros']
/** Days back from yesterday each played window covers. */
export const WINDOW_DAYS: Record<'d7' | 'd30', number> = { d7: 7, d30: 30 }
/** Fewest games in a window to be ranked in it: one big night is not a rank. */
export const MIN_GAMES: Record<'d7' | 'd30' | 'season', number> = { d7: 2, d30: 4, season: 4 }

export interface WindowRank {
  /** Among every player ranked in the window, 1 the best; null with too few games. */
  rank: number | null
  /** Under my punts (categories leagues); the same as rank where nothing is punted. */
  build: number | null
  games: number
}

export type PlayerRanks = Record<RankWindow, WindowRank>

export interface RankLeague {
  scoring: 'points' | 'categories'
  teams: number
  roster: Record<string, number>
  points?: Partial<Record<string, number>>
  punts?: Cat[]
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

const fpOf = (b: Box, w: Partial<Record<string, number>>) =>
  Object.entries(w).reduce((t, [k, x]) => t + (x ?? 0) * ((b as unknown as Record<string, number>)[k] ?? 0), 0)

/** His average over a run of games, as a projection: what the value model ranks. */
function asProjected(p: NbaPlayer, games: GameLog[]): NbaPlayer {
  const t = games.reduce((s, g) => {
    for (const k of Object.keys(s) as (keyof Box)[]) s[k] += g.box[k] ?? 0
    return s
  }, emptyBox())
  const n = games.length, min = games.reduce((s, g) => s + g.min, 0) / n
  return {
    ...p,
    projection: {
      ...(p.projection ?? { gp: n, gpSource: 'history' }),
      perGame: { min, pts: t.pts / n, reb: t.reb / n, ast: t.ast / n, stl: t.stl / n, blk: t.blk / n, tpm: t.tpm / n, to: t.to / n },
      shooting: { fga: t.fga / n, fgPct: t.fga ? t.fgm / t.fga : null, fta: t.fta / n, ftPct: t.fta ? t.ftm / t.fta : null },
    } as NbaPlayer['projection'],
  }
}

/** One window's ranks: the value of each player listed, best first, all categories and under my punts. */
function rankOne(ps: NbaPlayer[], league: RankLeague): Map<string, { rank: number; build: number }> {
  const out = new Map<string, { rank: number; build: number }>()
  let all: Map<string, number>, build: Map<string, number>
  if (league.scoring === 'points') {
    const w = league.points ?? {}
    const fp = (p: NbaPlayer) => {
      const g = p.projection!.perGame, s = p.projection!.shooting
      return fpOf({ ...emptyBox(), pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, tpm: g.tpm, to: g.to, fga: s.fga ?? 0, fta: s.fta ?? 0 }, w)
    }
    all = new Map(ps.filter((p) => p.projection).map((p) => [p.id, fp(p)]))
    build = all
  } else {
    const rows = categoryZ(ps, { teams: league.teams, roster: league.roster })
    const sum = (z: Record<Cat, number>, skip: Cat[]) => CATS.filter((c) => !skip.includes(c)).reduce((s, c) => s + z[c], 0)
    all = new Map(rows.map((r) => [r.id, sum(r.z, [])]))
    build = new Map(rows.map((r) => [r.id, sum(r.z, league.punts ?? [])]))
  }
  const order = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  order(all).forEach((id, i) => out.set(id, { rank: i + 1, build: 0 }))
  order(build).forEach((id, i) => { const o = out.get(id); if (o) o.build = i + 1 })
  return out
}

/**
 * Every player's rank in each window. `players` carry the companion's line for the rest of the season (in season,
 * the projection with form blended in); `logs` are this season's games. Played windows end yesterday: today's games
 * may still be on.
 */
export function rankPlayers(players: NbaPlayer[], logs: GameLog[], today: string, league: RankLeague): Map<string, PlayerRanks> {
  const byId = new Map<string, GameLog[]>()
  for (const l of logs) if (l.min > 0 && l.date < today) (byId.get(l.id) ?? byId.set(l.id, []).get(l.id)!).push(l)
  const known = players.filter((p) => p.team)
  const played = (w: 'd7' | 'd30' | 'season') => {
    const from = w === 'season' ? '' : addDays(today, -WINDOW_DAYS[w])
    const games = new Map(known.map((p) => [p.id, (byId.get(p.id) ?? []).filter((g) => g.date >= from)]))
    const ps = known.filter((p) => games.get(p.id)!.length >= MIN_GAMES[w]).map((p) => asProjected(p, games.get(p.id)!))
    return { ranks: rankOne(ps, league), games }
  }
  const windows = { d7: played('d7'), d30: played('d30'), season: played('season') }
  const ros = rankOne(known.filter((p) => p.projection && p.projection.perGame.min > 0), league)
  const out = new Map<string, PlayerRanks>()
  for (const p of known) {
    const r = {} as PlayerRanks
    for (const w of ['d7', 'd30', 'season'] as const) {
      const x = windows[w].ranks.get(p.id)
      r[w] = { rank: x?.rank ?? null, build: x?.build ?? null, games: windows[w].games.get(p.id)!.length }
    }
    const x = ros.get(p.id)
    r.ros = { rank: x?.rank ?? null, build: x?.build ?? null, games: 0 }
    out.set(p.id, r)
  }
  return out
}
