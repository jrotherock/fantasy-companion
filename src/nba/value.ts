/**
 * Basketball's two value models, one per league format.
 *
 * Points (Harker): a player is worth his fantasy points per game above the
 * replacement level, times the games he will play. Simple, and the scoring is
 * the edge — steals and blocks at three apiece are worth more there than any
 * generic points ranking assumes.
 *
 * Categories (Hoops): per-game z-scores in each of the nine categories, the
 * two percentages weighted by volume, measured against the pool that will
 * actually be rostered. A punt is a set of categories left out of the sum, so
 * every build is ranked by the same numbers rather than by a hand-typed map.
 *
 * Both use the same games figure. FantasyPros projects about seventy for nearly
 * everyone; three seasons of history say otherwise for a good number of them,
 * so where there are both the model takes their mean.
 */
import type { NbaPlayer } from './types.js'

export type Cat = 'fg' | 'ft' | 'tpm' | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'to'
export const CATS: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']

export const TEAM_GAMES = 82

export interface Games {
  gp: number
  how: 'blend' | 'projection' | 'history' | 'default' | 'injury'
}

/**
 * The mean of the projection and the player's own record, where there are both.
 * A rookie has no record, so his projection stands. History alone is used for
 * the players no source projects games for.
 */
export function effectiveGames(p: NbaPlayer): Games {
  const proj = p.projection
  if (!proj) return { gp: 0, how: 'default' }
  const history = p.durability.gpShare != null ? p.durability.gpShare * TEAM_GAMES : null
  if (proj.gpSource === 'fantasypros' && history != null) return { gp: Math.min(TEAM_GAMES, (proj.gp + history) / 2), how: 'blend' }
  if (proj.gpSource === 'fantasypros') return { gp: Math.min(TEAM_GAMES, proj.gp), how: 'projection' }
  if (proj.gpSource === 'history') return { gp: proj.gp, how: 'history' }
  // Already counted from his return date and his team's remaining schedule (see plan.ts).
  if (proj.gpSource === 'injury') return { gp: proj.gp, how: 'injury' }
  return { gp: proj.gp, how: 'default' }
}

/** Starters and bench; IL slots hold players who are not playing, so they do not set the replacement line. */
export function rosterSpots(roster: Record<string, number>): number {
  return Object.entries(roster).filter(([slot]) => slot !== 'IL').reduce((n, [, c]) => n + c, 0)
}

// ── Points ──────────────────────────────────────────────────────────────────

export interface PointsLeague {
  teams: number
  roster: Record<string, number>
  points: Partial<Record<'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'to' | 'tpm', number>>
}

export interface PointsRow {
  id: string
  name: string
  team: string | null
  positions: string[]
  fpg: number
  games: Games
  season: number
  /** Fantasy points per game above the replacement line, times games. */
  value: number
  rank: number
  yahooRank: number | null
}

export function fantasyPoints(p: NbaPlayer, weights: PointsLeague['points']): number {
  const g = p.projection?.perGame
  if (!g) return 0
  let fp = 0
  for (const [stat, w] of Object.entries(weights)) fp += (w ?? 0) * (g[stat as keyof typeof g] ?? 0)
  return fp
}

/**
 * The replacement line is the per-game output of the first player left over
 * once every roster is full. Per game rather than per season because lineups
 * are set daily: a missed game is filled from the wire, so what a player is
 * worth is how much better his games are than a streamer's.
 */
export function pointsValues(players: NbaPlayer[], league: PointsLeague): { rows: PointsRow[]; replacementFpg: number } {
  const base = players.filter((p) => p.projection).map((p) => {
    const fpg = fantasyPoints(p, league.points)
    const games = effectiveGames(p)
    return { p, fpg, games, season: fpg * games.gp }
  })
  const spots = league.teams * rosterSpots(league.roster)
  const bySeason = [...base].sort((a, b) => b.season - a.season)
  const replacementFpg = bySeason[spots]?.fpg ?? 0

  const rows = base
    .map(({ p, fpg, games, season }) => ({
      id: p.id, name: p.name, team: p.team, positions: p.positions, fpg, games, season,
      // Above the line, value grows with games. Below it, missing games must not make a
      // player look less bad, so the shortfall is counted over a full season.
      value: (fpg - replacementFpg) * (fpg >= replacementFpg ? games.gp : TEAM_GAMES), rank: 0, yahooRank: p.yahoo?.rank ?? null,
    }))
    .sort((a, b) => b.value - a.value)
  rows.forEach((r, i) => (r.rank = i + 1))
  return { rows, replacementFpg }
}

// ── Categories ──────────────────────────────────────────────────────────────

export interface CatLeague {
  teams: number
  roster: Record<string, number>
}

export interface CatRow {
  id: string
  name: string
  team: string | null
  positions: string[]
  games: Games
  /** Per-game z-score in each category; turnovers are already flipped so higher is better. */
  z: Record<Cat, number>
  yahooRank: number | null
}

/** What each category is measured in per game. Percentages become makes above the pool's rate on the player's attempts. */
function raw(p: NbaPlayer, fgRate: number, ftRate: number): Record<Cat, number> {
  const g = p.projection!.perGame
  const s = p.projection!.shooting
  const impact = (pct: number | null, att: number | null, rate: number) => (pct != null && att != null ? (pct - rate) * att : 0)
  return {
    fg: impact(s.fgPct, s.fga, fgRate),
    ft: impact(s.ftPct, s.fta, ftRate),
    tpm: g.tpm, pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk,
    to: -g.to,
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

function zScores(pool: NbaPlayer[], everyone: NbaPlayer[]): Map<string, Record<Cat, number>> {
  const att = (k: 'fga' | 'fta') => sum(pool.map((p) => p.projection!.shooting[k] ?? 0))
  const made = (pct: 'fgPct' | 'ftPct', k: 'fga' | 'fta') =>
    sum(pool.map((p) => (p.projection!.shooting[pct] ?? 0) * (p.projection!.shooting[k] ?? 0)))
  const fgRate = made('fgPct', 'fga') / att('fga')
  const ftRate = made('ftPct', 'fta') / att('fta')

  const poolRaw = pool.map((p) => raw(p, fgRate, ftRate))
  const mean = {} as Record<Cat, number>, sd = {} as Record<Cat, number>
  for (const c of CATS) {
    const xs = poolRaw.map((r) => r[c])
    mean[c] = sum(xs) / xs.length
    sd[c] = Math.sqrt(sum(xs.map((x) => (x - mean[c]) ** 2)) / xs.length) || 1
  }
  const out = new Map<string, Record<Cat, number>>()
  for (const p of everyone) {
    const r = raw(p, fgRate, ftRate)
    out.set(p.id, Object.fromEntries(CATS.map((c) => [c, (r[c] - mean[c]) / sd[c]])) as Record<Cat, number>)
  }
  return out
}

/**
 * Two passes. The first measures everyone against the players who play the
 * most minutes; the second against the players that first pass says will be
 * rostered. Measuring against the league's whole player list would make every
 * rotation player look like a star, because the average NBA player is not
 * on a fantasy roster.
 */
export function categoryZ(players: NbaPlayer[], league: CatLeague): CatRow[] {
  const projected = players.filter((p) => p.projection && p.projection.perGame.min > 0)
  const spots = league.teams * rosterSpots(league.roster)

  const byMinutes = [...projected].sort((a, b) => b.projection!.perGame.min - a.projection!.perGame.min)
  const first = zScores(byMinutes.slice(0, Math.round(spots * 1.5)), projected)
  const rostered = [...projected]
    .sort((a, b) => sum(Object.values(first.get(b.id)!)) - sum(Object.values(first.get(a.id)!)))
    .slice(0, spots)
  const z = zScores(rostered, projected)

  return projected.map((p) => ({
    id: p.id, name: p.name, team: p.team, positions: p.positions,
    games: effectiveGames(p), z: z.get(p.id)!, yahooRank: p.yahoo?.rank ?? null,
  }))
}

export interface Ranked {
  id: string
  name: string
  team: string | null
  positions: string[]
  /** Sum of per-game z over the categories kept. */
  perGame: number
  /** Per-game value above the replacement line, scaled by the share of games played. */
  value: number
  rank: number
  yahooRank: number | null
  gp: number
}

/**
 * Ranks every player for one build. `punt` lists the categories given up; the
 * rest are summed. The replacement line is drawn under the same build, since a
 * punt-FT% team's replacement is a different player from a balanced team's.
 * Season value scales by games: in head-to-head a player who misses a fifth of
 * the season gives you nothing in a fifth of the weeks.
 */
export function rankBuild(rows: CatRow[], league: CatLeague, punt: Cat[] = []): Ranked[] {
  const keep = CATS.filter((c) => !punt.includes(c))
  const spots = league.teams * rosterSpots(league.roster)
  const perGame = new Map(rows.map((r) => [r.id, sum(keep.map((c) => r.z[c]))]))
  const replacement = [...rows].sort((a, b) => perGame.get(b.id)! - perGame.get(a.id)!)[spots]
  const line = replacement ? perGame.get(replacement.id)! : 0

  const ranked = rows
    .map((r) => ({
      id: r.id, name: r.name, team: r.team, positions: r.positions,
      // Below the line the shortfall is not scaled down by games, or an injured
      // below-replacement player would rise for being hurt.
      perGame: perGame.get(r.id)!, value: (perGame.get(r.id)! - line) * (perGame.get(r.id)! >= line ? r.games.gp / TEAM_GAMES : 1),
      rank: 0, yahooRank: r.yahooRank, gp: r.games.gp,
    }))
    .sort((a, b) => b.value - a.value)
  ranked.forEach((r, i) => (r.rank = i + 1))
  return ranked
}

/**
 * A roster's strength in each category: the sum of its players' z, each
 * weighted by the share of games he plays. The weakest categories are the
 * ones the roster is already punting, whether or not that was the plan.
 */
export function rosterProfile(rows: CatRow[], ids: string[]): { totals: Record<Cat, number>; weakest: Cat[] } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const totals = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Cat, number>
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) continue
    for (const c of CATS) totals[c] += r.z[c] * (r.games.gp / TEAM_GAMES)
  }
  const weakest = [...CATS].sort((a, b) => totals[a] - totals[b])
  return { totals, weakest }
}
