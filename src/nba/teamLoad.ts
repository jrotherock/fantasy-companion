/**
 * The 240 check: a team has 240 minutes a game and only so many shots, so when
 * its players' projections add up to more than its share, somebody's line comes
 * down. Projections are per game played, so even a healthy rotation adds up to
 * more than 240 (absences make room); each team is read against the league's
 * own norm instead — the over-allocation every projection shares cancels out.
 *
 * The rotation is a team's ten players with the most projected minutes. "Plays"
 * are the possessions a player ends — shots, trips to the line (0.44 a free
 * throw attempt) and turnovers — the usual stand-in for usage.
 *
 * Preseason, these are guesses about roles nobody has played yet. Shown beside
 * players and in a team table, never folded into value: the projection services
 * already price roster moves, and this says whether they did and how crowded the
 * team is, for the reader to judge.
 */
import type { NbaPlayer } from './types.js'

export interface TeamLoad {
  team: string
  /** Projected minutes a game of the ten-man rotation (per game played). */
  rotationMin: number
  /** Against the league's norm, 100 = typical. */
  minPct: number
  /** Projected plays a game of the rotation, against the league's norm. */
  plays: number
  playsPct: number
  /** Rotation players new to the team: last season elsewhere, or rookies. */
  arrivals: { id: string; name: string; from: string | null; pts: number | null }[]
  /** Last season's rotation players now on other teams. */
  departures: { id: string; name: string; to: string | null }[]
  /** Judgement the feeds cannot carry (a new coach), from data/nba/team-notes.json. */
  notes: string[]
  /**
   * Plays a game the roster moves added: arrivals' last-season plays (rookies' projected)
   * less departures'. The squeeze on everyone already there: Portland adding Lillard
   * and Morant and losing Grant is about +25.
   */
  netPlays: number
}

export interface PlayerContext {
  team: string
  /** Last season's team, when it was another. */
  from: string | null
  /** Projected per game against last season's: fantasy points (points leagues) or points (categories). */
  delta: number | null
  unit: 'fp/g' | 'pts/g'
  minDelta: number | null
  /**
   * Categories leagues: the per-game lines that moved most (a point a game, a quarter of
   * a steal, two points of a percentage...), biggest first. Points leagues read `delta`.
   */
  changes: { cat: string; delta: number }[]
  /** Notable arrivals on his team (15+ points a game last season, or a rookie projected 25+ minutes), him excluded. */
  arrivals: string[]
  /** Notable departures from his team (15+ points a game last season). */
  departures: string[]
  /** Plays a game his team's moves added (or freed, negative). */
  netPlays: number
  playsPct: number
  rookie: boolean
  /** Whether his change is in the league's outer tenth either way, and the league's typical change. */
  unusual: boolean
  typical: number | null
}

/** How projections move from last season across the league: the middle, and the outer tenths. */
export interface ContextNorm { median: number; lo: number; hi: number }

export function contextNorm(deltas: number[]): ContextNorm | null {
  if (deltas.length < 20) return null
  const d = [...deltas].sort((a, b) => a - b), q = (f: number) => d[Math.floor((d.length - 1) * f)]
  return { median: q(0.5), lo: q(0.1), hi: q(0.9) }
}

const ROTATION = 10
/** An arrival worth naming: 12+ points a game last season, or a rookie projected for real minutes. */
const NOTABLE_PTS = 15
const ROOKIE_MIN = 20
const NOTABLE_ROOKIE_MIN = 25
/** A mover counted in net plays: 12+ points a game last season. */
const MOVER_PTS = 12

const playsOf = (p: NbaPlayer) => {
  const g = p.projection!.perGame, s = p.projection!.shooting
  return (s?.fga ?? 0) + 0.44 * (s?.fta ?? 0) + (g.to ?? 0)
}
const lastPlays = (p: NbaPlayer) => {
  const last = p.history?.at(-1)
  return last ? (last.shooting?.fga ?? 0) + 0.44 * (last.shooting?.fta ?? 0) + (last.perGame.to ?? 0) : 0
}

/** Last season's points a game for movers, projected minutes for rookies: who is worth naming. */
const lastOfId = new Map<string, number>()

export function teamLoads(players: NbaPlayer[], notes: Record<string, string[]> = {}): Map<string, TeamLoad> {
  for (const p of players) {
    const last = p.history?.at(-1)
    if (last) lastOfId.set(p.id, last.perGame.pts)
    else if (p.yearsExp === 0 && p.projection) lastOfId.set(p.id, p.projection.perGame.min)
  }
  const byTeam = new Map<string, NbaPlayer[]>()
  for (const p of players) {
    if (!p.team || !p.projection || !(p.projection.perGame.min > 0)) continue
    byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), p])
  }
  const raw = [...byTeam.entries()].filter(([, ps]) => ps.length >= 8).map(([team, ps]) => {
    const rot = [...ps].sort((a, b) => b.projection!.perGame.min - a.projection!.perGame.min).slice(0, ROTATION)
    return { team, ps, rotationMin: rot.reduce((s, p) => s + p.projection!.perGame.min, 0), plays: rot.reduce((s, p) => s + playsOf(p), 0) }
  })
  const normMin = raw.reduce((s, r) => s + r.rotationMin, 0) / Math.max(1, raw.length)
  const normPlays = raw.reduce((s, r) => s + r.plays, 0) / Math.max(1, raw.length)
  const out = new Map<string, TeamLoad>()
  for (const r of raw) {
    const arrivals = r.ps.flatMap((p): TeamLoad['arrivals'] => {
      const last = p.history?.at(-1)
      if (last?.team && last.team !== r.team && last.perGame.min >= ROOKIE_MIN) return [{ id: p.id, name: p.name, from: last.team, pts: last.perGame.pts }]
      if (p.yearsExp === 0 && p.projection!.perGame.min >= ROOKIE_MIN) return [{ id: p.id, name: p.name, from: null, pts: null }]
      return []
    }).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))
    out.set(r.team, {
      team: r.team, rotationMin: r.rotationMin, minPct: (100 * r.rotationMin) / normMin, plays: r.plays, playsPct: (100 * r.plays) / normPlays,
      arrivals, departures: [], notes: notes[r.team] ?? [],
      // Only movers who carried a load: four role players in for two stars out is room, not a squeeze.
      netPlays: r.ps.reduce((s, p) => {
        const last = p.history?.at(-1)
        if (last?.team && last.team !== r.team && last.perGame.min >= ROOKIE_MIN && last.perGame.pts >= MOVER_PTS) return s + lastPlays(p)
        if (p.yearsExp === 0 && p.projection!.perGame.min >= NOTABLE_ROOKIE_MIN) return s + playsOf(p)
        return s
      }, 0),
    })
  }
  for (const p of players) {
    const last = p.history?.at(-1)
    if (last?.team && p.team && last.team !== p.team && last.perGame.min >= ROOKIE_MIN) {
      const t = out.get(last.team)
      if (t) { t.departures.push({ id: p.id, name: p.name, to: p.team }); if (last.perGame.pts >= MOVER_PTS) t.netPlays -= lastPlays(p) }
    }
  }
  return out
}

/** One player's line against last season's, and who joined his team. */
export function playerContext(p: NbaPlayer, loads: Map<string, TeamLoad>, weights: Record<string, number> | null, norm: ContextNorm | null = null): PlayerContext | null {
  if (!p.team || !p.projection) return null
  const load = loads.get(p.team)
  if (!load) return null
  const last = p.history?.at(-1)
  const was = last && last.gp >= 20 ? last.perGame : null
  const now = p.projection.perGame
  const fp = (g: Record<string, number>) => Object.entries(weights ?? {}).reduce((s, [k, w]) => s + w * (g[k] ?? 0), 0)
  // A change worth naming, per category: counting stats by a share of last season's and a floor, percentages on volume.
  const changes: PlayerContext['changes'] = []
  if (was && !weights) {
    const floor: Record<string, number> = { pts: 1.5, reb: 0.8, ast: 0.7, stl: 0.25, blk: 0.25, tpm: 0.4, to: 0.4 }
    for (const k of Object.keys(floor)) {
      const d = ((now as any)[k] ?? 0) - ((was as any)[k] ?? 0)
      if (Math.abs(d) >= Math.max(floor[k], 0.15 * Math.abs((was as any)[k] ?? 0))) changes.push({ cat: k, delta: d })
    }
    const ws = last?.shooting, ns = p.projection.shooting
    if (ws && ns) {
      if ((ns.fga ?? 0) >= 5 && ns.fgPct != null && ws.fgPct != null && Math.abs(ns.fgPct - ws.fgPct) >= 0.02) changes.push({ cat: 'fg', delta: ns.fgPct - ws.fgPct })
      if ((ns.fta ?? 0) >= 2 && ns.ftPct != null && ws.ftPct != null && Math.abs(ns.ftPct - ws.ftPct) >= 0.03) changes.push({ cat: 'ft', delta: ns.ftPct - ws.ftPct })
    }
    // Biggest first, measured against each floor so a steal and a point compare fairly.
    const scale = (c: { cat: string; delta: number }) => Math.abs(c.delta) / (c.cat === 'fg' ? 0.02 : c.cat === 'ft' ? 0.03 : floor[c.cat])
    changes.sort((a, b) => scale(b) - scale(a))
  }
  const delta = was ? (weights ? fp(now as any) - fp(was as any) : now.pts - was.pts) : null
  const notableDeparture = (d: { id: string }) => { const q = lastOfId.get(d.id); return q != null && q >= NOTABLE_PTS }
  return {
    team: p.team,
    from: last?.team && last.team !== p.team ? last.team : null,
    delta,
    unusual: delta != null && norm != null && (delta <= norm.lo || delta >= norm.hi),
    typical: norm?.median ?? null,
    departures: load.departures.filter(notableDeparture).map((d) => d.name),
    netPlays: load.netPlays,
    unit: weights ? 'fp/g' : 'pts/g',
    minDelta: was ? now.min - was.min : null,
    changes: changes.slice(0, 3),
    arrivals: load.arrivals.filter((a) => a.id !== p.id && (a.pts != null ? a.pts >= NOTABLE_PTS : (lastOfId.get(a.id) ?? 0) >= NOTABLE_ROOKIE_MIN)).map((a) => a.name),
    playsPct: load.playsPct,
    rookie: p.yearsExp === 0,
  }
}

/** Worth a line on a card: a real change from last season, or a team crowded or emptied around him. */
export function contextWorthShowing(c: PlayerContext | null): boolean {
  if (!c) return false
  return c.unusual || c.from != null || c.arrivals.length > 0 || c.departures.length > 0 || c.playsPct >= 108 || c.playsPct <= 92
}
