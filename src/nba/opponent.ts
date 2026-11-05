/**
 * How much each team gives up, by stat, to each kind of player: per minute (so pace is in it), for guards (PG/SG),
 * forwards (SF/PF) and centers, against the league. A factor of 1.08 for points against guards means guards score 8%
 * more a minute against that team.
 *
 * Backtested (2026-11-04): over 2025's full season, lines moved toward these factors came out nearer the real ones
 * (a small gain, about half a percent, larger the stronger the move); over 2026's first two weeks it made no
 * difference either way. Half strength. Last season's numbers start each team off and this season's take over as its
 * games come (a team's own games weighed against 20 of last season's).
 */
import type { Box } from './yahooSeason.js'
import type { GameLog } from './outlook.js'
import type { Game } from './types.js'

export type Group = 'G' | 'F' | 'C'
export const STATS = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'] as const satisfies readonly (keyof Box)[]
type Stat = (typeof STATS)[number]

/** Minutes and stats given up, per defense and group, with the league's per group: what a season's file holds. */
export interface Allowed {
  league: Record<Group, { min: number; s: Record<Stat, number> }>
  teams: Record<string, { min: number; s: Record<Stat, number> }>
  games: Record<string, number>
}

/** Strength the backtest settled on, and how many of last season's games a team's own are weighed against. */
export const OPP_STRENGTH = 0.5
export const OPP_PRIOR_GAMES = 20
/** Fewer minutes than this against a group says nothing yet. */
const MIN_SEEN = 50

export const groupOf = (positions: string[] | undefined): Group => {
  const p = positions?.[0]
  return p === 'C' ? 'C' : p === 'SF' || p === 'PF' || p === 'F' ? 'F' : 'G'
}

const zero = () => Object.fromEntries(STATS.map((s) => [s, 0])) as Record<Stat, number>

/** Totals from game logs: each log's opponent from the schedule, his group from his positions. */
export function allowedFrom(logs: GameLog[], schedule: Game[], groupOfId: (id: string) => Group | null): Allowed {
  const out: Allowed = { league: { G: { min: 0, s: zero() }, F: { min: 0, s: zero() }, C: { min: 0, s: zero() } }, teams: {}, games: {} }
  const vs = new Map<string, string>()
  for (const g of schedule) { vs.set(`${g.home}|${g.date}`, g.away); vs.set(`${g.away}|${g.date}`, g.home) }
  const seen = new Map<string, Set<string>>()
  for (const l of logs) {
    if (!l.team || l.min <= 0) continue
    const opp = vs.get(`${l.team}|${l.date}`)
    const g = groupOfId(l.id)
    if (!opp || !g) continue
    const t = (out.teams[`${opp}|${g}`] ??= { min: 0, s: zero() })
    for (const x of [t, out.league[g]]) { x.min += l.min; for (const s of STATS) x.s[s] += l.box[s] }
    let d = seen.get(opp)
    if (!d) seen.set(opp, (d = new Set()))
    d.add(l.date)
  }
  for (const [t, d] of seen) out.games[t] = d.size
  return out
}

function raw(a: Allowed | null, team: string, g: Group, s: Stat): number | null {
  const x = a?.teams[`${team}|${g}`], L = a?.league[g]
  if (!x || !L || x.min < MIN_SEEN || L.s[s] <= 0 || L.min <= 0) return null
  return (x.s[s] / x.min) / (L.s[s] / L.min)
}

/** The factor for a stat against a team: this season's weighed against last season's (or 1), at `strength`. */
export function oppFactor(now: Allowed, prior: Allowed | null, team: string, g: Group, s: Stat, strength = OPP_STRENGTH): number {
  if (strength === 0) return 1
  const n = now.games[team] ?? 0
  const a = raw(now, team, g, s), base = raw(prior, team, g, s) ?? 1
  const f = a == null ? base : (n * a + OPP_PRIOR_GAMES * base) / (n + OPP_PRIOR_GAMES)
  return 1 + strength * (f - 1)
}

/** A line against a team, each stat moved by its factor. */
export function againstTeam(box: Box, now: Allowed, prior: Allowed | null, team: string, g: Group, strength = OPP_STRENGTH): Box {
  const out = { ...box }
  for (const s of STATS) out[s] = box[s] * oppFactor(now, prior, team, g, s, strength)
  return out
}
