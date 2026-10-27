/**
 * Yahoo's Fantasy API, read into plain records.
 *
 * Written against recorded answers, not the documentation, and every oddity
 * below was found in one:
 *
 *   - A record is an array of one-key objects — {player_key}, {name},
 *     {status} — with empty arrays scattered between them. It has to be
 *     flattened before a field can be read.
 *   - A list is an object keyed "0", "1", "2" with a count beside it, except
 *     where it is a real array, and an empty one arrives as [] rather than as a
 *     count of nought: the guillotine league's chopped team has `players: []`.
 *   - Numbers come as strings or numbers within one record. A standings row
 *     carried wins as "1" and losses as 0, points for as "111.06" and points
 *     against as 104.76.
 *   - The same field changes shape between siblings. In one add/drop, the add's
 *     transaction_data is an array and the drop's is a bare object.
 *   - A guillotine league has no opponents. Its scoreboard pairs every
 *     surviving team with whichever is projected lowest that week, so a
 *     "matchup" there is a distance from the chopping block, not a game.
 *
 * Nothing here resolves a player to the app's own ids or touches a store; it
 * only reads. That is what keeps it testable against a recording.
 */

/** Element i of a Yahoo collection, which is an array in some places and keyed "0", "1"… in others. */
export function at(x: unknown, i: number): any {
  if (x == null || typeof x !== 'object') return undefined
  return Array.isArray(x) ? x[i] : (x as Record<string, unknown>)[String(i)]
}

/**
 * A Yahoo collection as an array.
 *
 * Usually an object keyed "0", "1" beside a count. An empty one arrives as a
 * bare [] — the guillotine league's chopped team has `players: []` — and a few
 * places wrap a single record in a real array. Items of an array are the
 * collection rather than nothing, so a shape that changes cannot quietly take
 * the contents with it.
 */
export function list(x: unknown): any[] {
  if (!x || typeof x !== 'object') return []
  if (Array.isArray(x)) return x.filter((v) => v != null)
  const o = x as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
  return keys.map((k) => o[k]).filter((v) => v != null)
}

/** One record out of its one-key fragments. Arrays among them are placeholders. */
export function flat(parts: unknown): Record<string, any> {
  if (!parts || typeof parts !== 'object') return {}
  if (!Array.isArray(parts)) return parts as Record<string, any>
  const out: Record<string, any> = {}
  for (const p of parts) {
    if (p && typeof p === 'object' && !Array.isArray(p)) Object.assign(out, p)
  }
  return out
}

/** A number however Yahoo sent it; null for absent or unreadable, never NaN. */
export function num(x: unknown): number | null {
  if (x == null || x === '') return null
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : null
}

/**
 * Every league in an answer, as [meta, body].
 *
 * One league arrives as `league: [meta, body]` and several as a `leagues`
 * collection of the same, so every reader takes either.
 */
export function leagueNodes(json: any): { meta: Record<string, any>; body: Record<string, any> }[] {
  const fc = json?.fantasy_content ?? {}
  const one = fc.league
  const many = one ? [{ league: one }] : list(fc.leagues)
  return many
    .map((x) => x?.league)
    .filter(Array.isArray)
    .map((l: any[]) => ({ meta: flat(l[0]), body: flat(l.slice(1)) }))
}

/* ---------------------------------------------------------------- leagues */

export interface YLeague {
  key: string
  id: string
  name: string
  teams: number
  guillotine: boolean
  season: string
  currentWeek: number | null
  startWeek: number | null
  endWeek: number | null
  draftStatus: string | null
  scoringType: string | null
}

function leagueOf(m: Record<string, any>): YLeague {
  return {
    key: String(m.league_key),
    id: String(m.league_id),
    name: String(m.name ?? ''),
    teams: num(m.num_teams) ?? 0,
    guillotine: String(m.is_guillotine) === '1',
    season: String(m.season ?? ''),
    currentWeek: num(m.current_week),
    startWeek: num(m.start_week),
    endWeek: num(m.end_week),
    draftStatus: m.draft_status ?? null,
    scoringType: m.scoring_type ?? null,
  }
}

/** The account's leagues, from users;use_login=1/games;game_keys=nfl/leagues. */
export function parseDiscovery(json: any): YLeague[] {
  const users = json?.fantasy_content?.users
  const out: YLeague[] = []
  for (const u of list(users)) {
    const user = flat(u?.user?.slice?.(1))
    for (const g of list(user.games)) {
      const game = flat(g?.game?.slice?.(1))
      for (const l of list(game.leagues)) {
        if (Array.isArray(l?.league)) out.push(leagueOf(flat(l.league[0])))
      }
    }
  }
  return out
}

export const leagueMeta = leagueOf

/* ---------------------------------------------------------------- players */

export interface YPlayer {
  key: string
  /** Yahoo's own player id, which is what the player map stores as ids.yahoo. */
  yahooId: string
  name: string
  /** As Yahoo displays it: 'RB', 'DEF', and for defenders 'LB,DE' or 'DB,S'. */
  display: string
  primary: string | null
  eligible: string[]
  /** Upper-cased, which makes Yahoo's 'Hou' and 'Jax' the player map's codes. */
  team: string | null
  status: string | null
  injury: string | null
  /** The slot he fills in the lineup this answer describes: 'QB', 'W/R/T', 'BN', 'IR'. */
  slot: string | null
  /** Points for the week asked about, where the answer carried them. */
  points: number | null
  byeWeek: number | null
}

export function parsePlayer(p: unknown): YPlayer | null {
  if (!Array.isArray(p)) return null
  const m = flat(p[0])
  const tail = flat(p.slice(1))
  if (!m.player_key) return null
  const slot = flat(tail.selected_position).position
  const points = tail.player_points ? num(tail.player_points.total) : null
  return {
    key: String(m.player_key),
    yahooId: String(m.player_id ?? String(m.player_key).split('.').pop()),
    name: String(m.name?.full ?? ''),
    display: String(m.display_position ?? ''),
    primary: m.primary_position ?? null,
    eligible: (Array.isArray(m.eligible_positions) ? m.eligible_positions : [])
      .map((e: any) => e?.position).filter(Boolean),
    team: m.editorial_team_abbr ? String(m.editorial_team_abbr).toUpperCase() : null,
    status: m.status ? String(m.status) : null,
    injury: m.injury_note ? String(m.injury_note) : null,
    slot: slot ? String(slot) : null,
    points,
    byeWeek: num(m.bye_weeks?.week),
  }
}

/* ------------------------------------------------------------------ teams */

export interface YTeam {
  key: string
  id: string
  name: string
  manager: string
  /** Yahoo says which team is the signed-in user's, so nobody has to configure it. */
  mine: boolean
  players: YPlayer[]
}

function teamOf(parts: unknown): Omit<YTeam, 'players'> {
  const m = flat(parts)
  const managers = Array.isArray(m.managers) ? m.managers : list(m.managers)
  const mgr = flat(managers.map((x: any) => x?.manager).filter(Boolean)[0])
  return {
    key: String(m.team_key),
    id: String(m.team_id),
    name: String(m.name ?? ''),
    manager: String(mgr.nickname ?? m.name ?? ''),
    mine: Number(m.is_owned_by_current_login) === 1 || String(mgr.is_current_login) === '1',
  }
}

function rosterPlayers(roster: unknown): YPlayer[] {
  return list(at(roster, 0)?.players)
    .map((x) => parsePlayer(x?.player))
    .filter((p): p is YPlayer => p != null)
}

/** Every team in a league body with its roster, from …/teams/roster. */
export function parseRosters(body: Record<string, any>): YTeam[] {
  return list(body.teams).map((t) => {
    const team = Array.isArray(t?.team) ? t.team : []
    return { ...teamOf(team[0]), players: rosterPlayers(flat(team.slice(1)).roster) }
  })
}

/** One team's week, from team/{key}/roster;week=N/players/stats. */
export function parseTeamWeek(json: any): (YTeam & { week: number | null }) | null {
  const team = json?.fantasy_content?.team
  if (!Array.isArray(team)) return null
  const rest = flat(team.slice(1))
  return {
    ...teamOf(team[0]),
    week: num(rest.roster?.week),
    players: rosterPlayers(rest.roster),
  }
}

/* ------------------------------------------------------------- scoreboard */

export interface YSide {
  teamKey: string
  teamId: string
  name: string
  points: number | null
  projected: number | null
}

export interface YMatchup {
  week: number | null
  /** 'preevent', 'midevent' or 'postevent'. */
  status: string | null
  playoffs: boolean
  consolation: boolean
  tied: boolean
  winnerTeamId: string | null
  sides: YSide[]
}

export interface YScoreboard { week: number | null; matchups: YMatchup[] }

export function parseScoreboard(body: Record<string, any>): YScoreboard | null {
  const sb = body.scoreboard
  if (!sb) return null
  const matchups = list(at(sb, 0)?.matchups).map((x) => {
    const m = x?.matchup ?? {}
    const sides = list(at(m, 0)?.teams).map((t) => {
      const team = Array.isArray(t?.team) ? t.team : []
      const meta = teamOf(team[0])
      const score = flat(team.slice(1))
      return {
        teamKey: meta.key, teamId: meta.id, name: meta.name,
        points: num(score.team_points?.total),
        projected: num(score.team_projected_points?.total),
      }
    })
    const winner = m.winner_team_key ? String(m.winner_team_key).split('.').pop() ?? null : null
    return {
      week: num(m.week),
      status: m.status ?? null,
      playoffs: String(m.is_playoffs) === '1',
      consolation: String(m.is_consolation) === '1',
      tied: String(m.is_tied) === '1',
      winnerTeamId: winner,
      sides,
    }
  })
  return { week: num(sb.week), matchups }
}

/* -------------------------------------------------------------- standings */

export interface YStanding {
  teamId: string
  name: string
  manager: string
  mine: boolean
  /** Head-to-head leagues. */
  rank: number | null
  wins: number | null
  losses: number | null
  ties: number | null
  pointsFor: number | null
  pointsAgainst: number | null
  /**
   * Guillotine leagues, which have none of the above. `rankWeek` is the order
   * by this week's live projection, and `fromChop` is Yahoo's own margin: live
   * points less those of the team projected lowest, or, for that team itself,
   * less those of the next lowest.
   */
  rankWeek: number | null
  pointsWeek: number | null
  projectedWeek: number | null
  fromChop: number | null
  faab: number | null
}

export function parseStandings(body: Record<string, any>): YStanding[] {
  return list(at(body.standings, 0)?.teams).map((t) => {
    const team = Array.isArray(t?.team) ? t.team : []
    const meta = teamOf(team[0])
    const s = flat(team.slice(1)).team_standings ?? {}
    const o = s.outcome_totals ?? {}
    return {
      teamId: meta.id, name: meta.name, manager: meta.manager, mine: meta.mine,
      rank: num(s.rank),
      wins: num(o.wins), losses: num(o.losses), ties: num(o.ties),
      pointsFor: num(s.points_for),
      pointsAgainst: num(s.points_against),
      rankWeek: num(s.rank_week),
      pointsWeek: num(s.points_week),
      projectedWeek: num(s.projected_points_week),
      fromChop: num(s.points_from_chop),
      faab: num(s.fab_balance),
    }
  })
}

/* ----------------------------------------------------------- transactions */

export interface YMovePlayer {
  player: YPlayer
  /** 'add', 'drop' or 'trade'. */
  kind: string
  fromTeamId: string | null
  toTeamId: string | null
  /** Where he went when nobody took him: 'waivers' or 'freeagents'. */
  toType: string | null
  fromType: string | null
}

export interface YTransaction {
  key: string
  id: string
  /** 'add', 'drop', 'add/drop', 'trade', 'commish'. */
  type: string
  status: string
  at: number
  faabBid: number | null
  players: YMovePlayer[]
  /** A pending waiver claim: the day it is processed and the player arrives (Yahoo's roster-reflect date). */
  waiverDate?: string | null
}

const teamIdOf = (k: unknown) => (k ? String(k).split('.').pop() ?? null : null)

export function parseTransactions(body: Record<string, any>): YTransaction[] {
  return list(body.transactions).map((x) => {
    const t = Array.isArray(x?.transaction) ? x.transaction : []
    const meta = flat(t[0])
    const players = list(flat(t.slice(1)).players).map((y) => {
      const p = Array.isArray(y?.player) ? y.player : []
      const player = parsePlayer([p[0]])
      // An array for the add, a bare object for the drop, in the same move.
      const raw = flat(p.slice(1)).transaction_data
      const d = flat(Array.isArray(raw) ? raw[0] : raw)
      return player && {
        player,
        kind: String(d.type ?? ''),
        fromTeamId: teamIdOf(d.source_team_key),
        toTeamId: teamIdOf(d.destination_team_key),
        toType: d.destination_type ?? null,
        fromType: d.source_type ?? null,
      }
    }).filter((m): m is YMovePlayer => !!m)
    return {
      key: String(meta.transaction_key ?? ''),
      id: String(meta.transaction_id ?? ''),
      type: String(meta.type ?? ''),
      status: String(meta.status ?? ''),
      at: (num(meta.timestamp) ?? 0) * 1000,
      faabBid: num(meta.faab_bid),
      players,
      waiverDate: meta.waiver_roster_reflect_key ?? meta.waiver_date ?? null,
    }
  })
}

/* --------------------------------------------------------------- settings */

export interface YSettings {
  positions: { pos: string; count: number; starting: boolean }[]
  /** Yahoo's stat id to its name and the points it is worth here. */
  scored: { id: string; name: string; group: string | null; value: number }[]
  faab: boolean
  waiverType: string | null
  waiverRule: string | null
  /** Days a dropped player spends on waivers. */
  waiverDays: number | null
  draftTime: number | null
  playoffStartWeek: number | null
}

export function parseSettings(body: Record<string, any>): YSettings | null {
  const s = flat(at(body.settings, 0))
  if (!s.roster_positions) return null
  const positions = (Array.isArray(s.roster_positions) ? s.roster_positions : list(s.roster_positions))
    .map((r: any) => r?.roster_position)
    .filter(Boolean)
    .map((r: any) => ({
      pos: String(r.position),
      count: num(r.count) ?? 0,
      starting: Number(r.is_starting_position) === 1,
    }))
  const cats = new Map<string, { name: string; group: string | null }>()
  for (const c of s.stat_categories?.stats ?? []) {
    const st = c?.stat
    if (st?.stat_id != null) {
      cats.set(String(st.stat_id), { name: String(st.name ?? ''), group: st.position_type ?? null })
    }
  }
  const scored = (s.stat_modifiers?.stats ?? [])
    .map((m: any) => m?.stat)
    .filter((m: any) => m?.stat_id != null && num(m.value) != null)
    .map((m: any) => {
      const id = String(m.stat_id)
      return { id, name: cats.get(id)?.name ?? '', group: cats.get(id)?.group ?? null, value: num(m.value)! }
    })
  const draft = num(s.draft_time)
  return {
    positions,
    scored,
    faab: String(s.uses_faab) === '1',
    waiverType: s.waiver_type ?? null,
    waiverRule: s.waiver_rule ?? null,
    waiverDays: num(s.waiver_time),
    draftTime: draft == null ? null : draft * 1000,
    playoffStartWeek: num(s.playoff_start_week),
  }
}
