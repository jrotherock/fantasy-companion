/**
 * What a player is expected to do from here: in one game, over a week, over
 * the rest of the season.
 *
 * Three sources, in the order they are trusted for a given day:
 *   1. Sleeper's projection for that date. Sleeper publishes one per player per
 *      game in-season (`/projections/nba/{season}/{week}`), and it moves with
 *      minutes, role and rest — the things a preseason line cannot know.
 *   2. His form: the preseason consensus blended with what he has done this
 *      season (`/stats/nba/{season}/{week}`, Sleeper's dated game log), more of
 *      the season the more games he has played.
 *   3. The preseason consensus alone, before he has played.
 * Whether he plays at all is a separate number, from his injury designation and
 * any return date.
 */
import type { NbaPlayer, PerGame, Shooting } from './types.js'
import { emptyBox, type Box } from './yahooSeason.js'

export interface GameLog {
  id: string
  date: string
  team: string | null
  /** Minutes played. */
  min: number
  box: Box
}

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

function boxFromSleeper(s: Record<string, unknown>): Box {
  return {
    fgm: n(s.fgm), fga: n(s.fga), ftm: n(s.ftm), fta: n(s.fta), tpm: n(s.tpm),
    pts: n(s.pts), reb: n(s.reb), ast: n(s.ast), stl: n(s.stl), blk: n(s.blk), to: n(s.to),
  }
}

/** Sleeper's dated game log for a week. Rows with no stats are players who did not play. */
export function parseSleeperLogs(rows: any[]): GameLog[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.player_id && r.date && r.stats && (n(r.stats.sp) > 0 || n(r.stats.pts) > 0 || n(r.stats.fga) > 0))
    .map((r) => ({ id: String(r.player_id), date: String(r.date), team: r.team ?? null, min: n(r.stats.sp) / 60, box: boxFromSleeper(r.stats) }))
}

/** Sleeper's projections for each game of a week, keyed `id|date`. */
export function parseSleeperDayProjections(rows: any[]): Map<string, { box: Box; min: number }> {
  const out = new Map<string, { box: Box; min: number }>()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.player_id || !r.date || !r.stats || !(n(r.stats.gp) > 0)) continue
    out.set(`${r.player_id}|${r.date}`, { box: boxFromSleeper(r.stats), min: n(r.stats.sp) / 60 })
  }
  return out
}

/** A projection's per-game line as a box. */
export function perGameBox(p: NbaPlayer): Box {
  const g = p.projection?.perGame, s = p.projection?.shooting
  if (!g || !s) return emptyBox()
  const fga = s.fga ?? 0, fta = s.fta ?? 0
  return {
    fgm: fga * (s.fgPct ?? 0), fga, ftm: fta * (s.ftPct ?? 0), fta,
    tpm: g.tpm, pts: g.pts, reb: g.reb, ast: g.ast, stl: g.stl, blk: g.blk, to: g.to,
  }
}

/**
 * Games of this season it takes to trust them as much as the preseason line.
 * Twelve is where a season's per-game numbers settle for most stats in
 * basketball; minutes settle sooner, shooting much later — but one number keeps
 * the blend explainable.
 */
export const FORM_GAMES = 12

/**
 * The player with his projection moved toward what he has done. Returns him
 * unchanged with no games logged. `gp` is left alone: games left is a separate
 * question (see gamesLeft).
 */
export function withForm(p: NbaPlayer, logs: GameLog[]): NbaPlayer & { formGames: number; recentMin: number | null; seasonMin: number | null } {
  const mine = logs.filter((l) => l.id === p.id).sort((a, b) => a.date.localeCompare(b.date))
  const games = mine.length
  const seasonMin = games ? mine.reduce((s, l) => s + l.min, 0) / games : null
  const last = mine.slice(-5)
  const recentMin = last.length ? last.reduce((s, l) => s + l.min, 0) / last.length : null
  if (!games || !p.projection) return { ...p, formGames: games, recentMin, seasonMin }
  const w = games / (games + FORM_GAMES)
  const tot = mine.reduce((acc, l) => { for (const k of Object.keys(acc) as (keyof Box)[]) acc[k] += l.box[k]; return acc }, emptyBox())
  const per = (k: keyof Box) => tot[k] / games
  const g = p.projection.perGame, s = p.projection.shooting
  const mix = (a: number, b: number) => a * (1 - w) + b * w
  const perGame: PerGame = {
    min: mix(g.min, seasonMin!), pts: mix(g.pts, per('pts')), reb: mix(g.reb, per('reb')), ast: mix(g.ast, per('ast')),
    stl: mix(g.stl, per('stl')), blk: mix(g.blk, per('blk')), tpm: mix(g.tpm, per('tpm')), to: mix(g.to, per('to')),
  }
  const fga = mix(s.fga ?? 0, per('fga')), fta = mix(s.fta ?? 0, per('fta'))
  // Percentages are blended in makes, weighted by attempts, so a cold week on few shots barely moves them.
  const pct = (prior: number | null, priorAtt: number | null, made: number, att: number) => {
    const pa = (priorAtt ?? 0) * FORM_GAMES, pm = (prior ?? 0) * pa
    return pa + att > 0 ? (pm + made) / (pa + att) : prior
  }
  const shooting: Shooting = {
    fga, fta,
    fgPct: pct(s.fgPct, s.fga, tot.fgm, tot.fga),
    ftPct: pct(s.ftPct, s.fta, tot.ftm, tot.fta),
  }
  return { ...p, projection: { ...p.projection, perGame, shooting }, formGames: games, recentMin, seasonMin }
}

/** Designations from Yahoo and Sleeper, folded into one scale. */
export type Designation = 'healthy' | 'probable' | 'questionable' | 'doubtful' | 'out' | 'injured' | 'suspended' | 'inactive'

export function designation(...codes: (string | null | undefined)[]): Designation {
  let worst: Designation = 'healthy'
  const rank: Designation[] = ['healthy', 'probable', 'questionable', 'doubtful', 'out', 'suspended', 'injured', 'inactive']
  for (const raw of codes) {
    const c = (raw ?? '').trim().toUpperCase()
    let d: Designation = 'healthy'
    if (!c) continue
    if (c === 'P' || c.startsWith('PROB')) d = 'probable'
    else if (c === 'GTD' || c === 'DTD' || c === 'Q' || c.startsWith('QUES') || c.startsWith('DAY')) d = 'questionable'
    else if (c === 'D' || c.startsWith('DOUBT')) d = 'doubtful'
    else if (c === 'O' || c === 'OUT') d = 'out'
    else if (c === 'INJ' || c === 'IL' || c.startsWith('IR')) d = 'injured'
    else if (c.startsWith('SUSP')) d = 'suspended'
    else if (c === 'NA' || c === 'NR' || c.startsWith('INACT')) d = 'inactive'
    if (rank.indexOf(d) > rank.indexOf(worst)) worst = d
  }
  return worst
}

/** Days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000)
}

/** Healthy players still sit: rest nights, a tweak nobody reported. */
export const HEALTHY_PLAY = 0.95

/**
 * The chance he plays on `date`, seen from `today`. A designation speaks
 * mostly to the next game; further out it fades toward his usual rate unless
 * there is a return date, which is a floor on the absence.
 */
export function playChance(d: Designation, date: string, today: string, returnDate: string | null = null, outForSeason = false): number {
  if (outForSeason) return 0
  const ahead = daysBetween(today, date)
  if (returnDate && date < returnDate) return 0
  // In the first days after a return date he may still be eased back or sat.
  if (returnDate && daysBetween(returnDate, date) < 4) return 0.5
  switch (d) {
    case 'healthy': return HEALTHY_PLAY
    case 'probable': return ahead <= 0 ? 0.9 : HEALTHY_PLAY
    case 'questionable': return ahead <= 0 ? 0.6 : ahead <= 2 ? 0.8 : 0.9
    case 'doubtful': return ahead <= 0 ? 0.2 : ahead <= 2 ? 0.5 : 0.8
    case 'out': return ahead <= 0 ? 0 : ahead <= 2 ? 0.3 : 0.6
    case 'injured': return returnDate ? 0.7 : ahead <= 6 ? 0.1 : 0.35
    case 'suspended': return ahead <= 0 ? 0 : 0.5
    case 'inactive': return 0
  }
}
