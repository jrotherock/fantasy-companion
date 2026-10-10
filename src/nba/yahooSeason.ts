/**
 * Reading a basketball season from the Yahoo API. Pure, like yahooDraft.ts.
 *
 * Shapes, from Hoops 2025's real answers (466.l.43113), read 2026-10-02:
 *
 *   league/{key}/scoreboard;week=N
 *     matchup { week, week_start, week_end, status, is_playoffs, is_consolation,
 *               winner_team_key, stat_winners [{ stat_winner { stat_id, winner_team_key | is_tied } }],
 *               teams [ team [ meta…, { team_stats { stats [{ stat { stat_id, value }}] },
 *                                       team_points { total },            ← categories won, or fantasy points
 *                                       team_remaining_games { total { remaining_games, live_games, completed_games } } } ] ] }
 *     A team's meta carries roster_adds { coverage_type: 'week', value } — adds used this week —
 *     and number_of_moves, the season's adds.
 *   team/{key}/roster;date=D/players/stats;type=date;date=D
 *     players with selected_position [{ coverage_type: 'date', date }, { position }, { is_flex }]
 *     and player_stats { stats [...] } for that day.
 *   game/{key}/game_weeks  game_week { week, start, end }
 *   league/{key}/settings  max_adds, max_weekly_adds, trade_end_date, playoff_start_week, num_playoff_teams
 *
 * Stat ids: 9004003 FGM/A ("254/478"), 5 FG%, 9007006 FTM/A, 8 FT%, 10 3PTM,
 * 12 PTS, 15 REB, 16 AST, 17 STL, 18 BLK, 19 TO. Percentages come as ".531";
 * the made/attempted pair is what a total is built from, never the percentage.
 */
import { at, flat, leagueNodes, list, num, parsePlayer, type YPlayer } from '../server/yahooParse.js'
import type { YahooWeek } from './types.js'
import type { Cat } from './value.js'

/** A box line: made and attempted shots, so percentages can be summed honestly. */
export interface Box {
  fgm: number; fga: number; ftm: number; fta: number
  tpm: number; pts: number; reb: number; ast: number; stl: number; blk: number; to: number
}

export const emptyBox = (): Box => ({ fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0 })

export function addBox(a: Box, b: Box, k = 1): Box {
  const out = { ...a }
  for (const key of Object.keys(out) as (keyof Box)[]) out[key] += b[key] * k
  return out
}

const SINGLE: Record<string, keyof Box> = { '10': 'tpm', '12': 'pts', '15': 'reb', '16': 'ast', '17': 'stl', '18': 'blk', '19': 'to' }

/** A Yahoo stats list as a box line; null when the answer carried no stats at all. */
export function boxOf(stats: unknown): Box | null {
  const rows = (Array.isArray(stats) ? stats : list(stats)).map((s: any) => s?.stat).filter(Boolean)
  if (!rows.length) return null
  // A day's line before his game: every value '-' (or '-/-'). No line yet, not a line of zeros.
  if (rows.every((s: any) => /^-(\/-)?$/.test(String(s.value ?? '').trim()))) return null
  const b = emptyBox()
  for (const s of rows) {
    const id = String(s.stat_id), v = String(s.value ?? '')
    if (id === '9004003' || id === '9007006') {
      const [m, a] = v.split('/').map((x) => num(x) ?? 0)
      if (id === '9004003') { b.fgm = m; b.fga = a } else { b.ftm = m; b.fta = a }
    } else if (SINGLE[id]) b[SINGLE[id]] = num(v) ?? 0
  }
  return b
}

/** A box line in the league's categories: percentages from makes over attempts. */
export function catsOf(b: Box): Record<Cat, number> {
  return {
    fg: b.fga ? b.fgm / b.fga : 0, ft: b.fta ? b.ftm / b.fta : 0,
    tpm: b.tpm, pts: b.pts, reb: b.reb, ast: b.ast, stl: b.stl, blk: b.blk, to: b.to,
  }
}

const CAT_OF_STAT: Record<string, Cat> = { '5': 'fg', '8': 'ft', '10': 'tpm', '12': 'pts', '15': 'reb', '16': 'ast', '17': 'stl', '18': 'blk', '19': 'to' }

export interface TeamMeta {
  key: string
  id: string
  name: string
  manager: string
  mine: boolean
  /** Adds used in the current week, where Yahoo counts them weekly. */
  addsThisWeek: number | null
  /** Adds and other moves over the season. */
  moves: number | null
  waiverPriority: number | null
  faab: number | null
}

export function teamMeta(parts: unknown): TeamMeta {
  const m = flat(parts)
  const managers = Array.isArray(m.managers) ? m.managers : list(m.managers)
  const mgr = flat(managers.map((x: any) => x?.manager).filter(Boolean)[0])
  return {
    key: String(m.team_key),
    id: String(m.team_id),
    name: String(m.name ?? ''),
    manager: String(mgr.nickname ?? m.name ?? ''),
    mine: Number(m.is_owned_by_current_login) === 1 || String(mgr.is_current_login) === '1',
    addsThisWeek: m.roster_adds?.coverage_type === 'week' ? num(m.roster_adds.value) : null,
    moves: num(m.number_of_moves),
    waiverPriority: num(m.waiver_priority),
    faab: num(m.faab_balance),
  }
}

export interface Side extends TeamMeta {
  box: Box | null
  /** Categories won so far in a category league; fantasy points in a points league. */
  points: number | null
  projected: number | null
  games: { remaining: number; live: number; completed: number } | null
}

export interface NbaMatchup {
  week: number
  start: string | null
  end: string | null
  status: string | null
  playoffs: boolean
  consolation: boolean
  winnerTeamId: string | null
  sides: Side[]
  /** Who is winning each category, by team id, or 'tie'. Only finished or running weeks have it. */
  leaders: Partial<Record<Cat, string>>
}

const idOfKey = (k: unknown) => (k ? String(k).split('.').pop() ?? null : null)

export function parseNbaScoreboard(json: any): NbaMatchup[] {
  const node = leagueNodes(json)[0]
  const sb = node?.body.scoreboard
  if (!sb) return []
  return list(at(sb, 0)?.matchups).map((x) => {
    const m = x?.matchup ?? {}
    const sides: Side[] = list(at(m, 0)?.teams).map((t) => {
      const team = Array.isArray(t?.team) ? t.team : []
      const rest = flat(team.slice(1))
      const rg = rest.team_remaining_games?.total
      return {
        ...teamMeta(team[0]),
        box: boxOf(rest.team_stats?.stats),
        points: num(rest.team_points?.total),
        projected: num(rest.team_projected_points?.total),
        games: rg ? { remaining: num(rg.remaining_games) ?? 0, live: num(rg.live_games) ?? 0, completed: num(rg.completed_games) ?? 0 } : null,
      }
    })
    const leaders: Partial<Record<Cat, string>> = {}
    for (const w of list(m.stat_winners)) {
      const s = w?.stat_winner
      const cat: Cat | undefined = s ? CAT_OF_STAT[String(s.stat_id)] : undefined
      if (!cat) continue
      leaders[cat] = String(s.is_tied) === '1' ? 'tie' : idOfKey(s.winner_team_key) ?? 'tie'
    }
    return {
      week: num(m.week) ?? num(sb.week) ?? 0,
      start: m.week_start ?? null,
      end: m.week_end ?? null,
      status: m.status ?? null,
      playoffs: String(m.is_playoffs) === '1',
      consolation: String(m.is_consolation) === '1',
      winnerTeamId: idOfKey(m.winner_team_key),
      sides,
      leaders,
    }
  })
}

export interface DayPlayer extends YPlayer {
  /** What he did on the day asked about; null when the answer carried no stats. */
  box: Box | null
}

export interface RosterDay {
  team: TeamMeta
  date: string | null
  players: DayPlayer[]
}

/** One team's roster on one day, with that day's slots and box lines. */
export function parseRosterDay(json: any): RosterDay | null {
  const team = json?.fantasy_content?.team
  if (!Array.isArray(team)) return null
  const roster = flat(team.slice(1)).roster
  const players = list(at(roster, 0)?.players).map((x: any) => {
    const p = x?.player
    const base = parsePlayer(p)
    if (!base) return null
    const tail = flat(Array.isArray(p) ? p.slice(1) : [])
    return { ...base, box: boxOf(tail.player_stats?.stats) }
  }).filter((p): p is DayPlayer => p != null)
  return { team: teamMeta(team[0]), date: roster?.date ?? null, players }
}

/** Every team's roster in a league answer (…/teams/roster), with each team's add counters. */
export function parseLeagueRosters(json: any): { team: TeamMeta; players: YPlayer[] }[] {
  const node = leagueNodes(json)[0]
  if (!node) return []
  return list(node.body.teams).map((t: any) => {
    const team = Array.isArray(t?.team) ? t.team : []
    const roster = flat(team.slice(1)).roster
    const players = list(at(roster, 0)?.players).map((x: any) => parsePlayer(x?.player)).filter((p): p is YPlayer => p != null)
    return { team: teamMeta(team[0]), players }
  })
}

/** The players in a league players collection (free agents, waivers). */
export function parsePlayers(json: any): YPlayer[] {
  const node = leagueNodes(json)[0]
  if (!node) return []
  return list(node.body.players).map((x: any) => parsePlayer(x?.player)).filter((p): p is YPlayer => p != null)
}

export function parseGameWeeks(json: any): YahooWeek[] {
  const game = json?.fantasy_content?.game
  const body = flat(Array.isArray(game) ? game.slice(1) : [])
  return list(body.game_weeks)
    .map((x: any) => x?.game_week)
    .filter((w: any) => w && w.week)
    .map((w: any): YahooWeek => [Number(w.week), String(w.start), String(w.end)])
}

export interface SeasonSettings {
  maxAdds: number | null
  maxWeeklyAdds: number | null
  tradeEnd: string | null
  playoffStartWeek: number | null
  playoffTeams: number | null
  waiverType: string | null
  /** Days a dropped player spends on waivers. */
  waiverDays: number | null
  faab: boolean
  scoringType: string | null
}

export function parseSeasonSettings(json: any): SeasonSettings | null {
  const node = leagueNodes(json)[0]
  if (!node) return null
  const s = flat(at(node.body.settings, 0))
  if (!Object.keys(s).length) return null
  const zeroIsNone = (x: unknown) => { const n = num(x); return n == null || n === 0 ? null : n }
  return {
    maxAdds: zeroIsNone(s.max_adds),
    maxWeeklyAdds: zeroIsNone(s.max_weekly_adds),
    tradeEnd: s.trade_end_date ? String(s.trade_end_date) : null,
    playoffStartWeek: num(s.playoff_start_week),
    playoffTeams: num(s.num_playoff_teams),
    waiverType: s.waiver_type ?? null,
    waiverDays: num(s.waiver_time),
    faab: String(s.uses_faab) === '1',
    scoringType: node.meta.scoring_type ?? s.scoring_type ?? null,
  }
}
