/**
 * The Yahoo leagues, kept current from the API.
 *
 * Four features were built against data the browser sensor could never
 * supply — the trade finder, the opponent's lineup, the transaction digest and
 * the luck split — and sat dark all season behind "no league-wide capture
 * yet". This fills the stores they read, so they light up without changing.
 *
 * Cheap on purpose. Every league-wide question is asked once for all the
 * leagues together, which Yahoo allows (`leagues;league_keys=a,b,c/...`), so
 * a round is a handful of requests however many leagues there are. The only
 * per-league calls are the two lineups in a head-to-head week — mine and his —
 * because Yahoo will not nest a week's points inside a multi-team collection:
 * asked for, they are silently dropped.
 *
 * Each part keeps its own clock and its own last good answer. A round that
 * fails at transactions still delivers the scoreboard, and a failed part leaves
 * what it read last time exactly where it was: a stale digest is worth having,
 * an empty one is a false statement about the league.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PlayerIndex } from '../kernel/match.js'
import type { FlexSlot, LeagueConfig, Player, PlayerId, Pos } from '../kernel/types.js'
import { statePath } from './paths.js'
import * as api from './yahooApi.js'
import { YahooError } from './yahooApi.js'
import * as Y from './yahooParse.js'
import * as leagueStore from './yahooLeague.js'
import * as rosterStore from './yahooRoster.js'
import type { Move } from './transactions.js'
import type { WeekScores } from './allplay.js'

/* ------------------------------------------------------------------ calls */

const many = (keys: string[]) => `leagues;league_keys=${[...keys].sort().join(',')}`

/** Every request this adapter makes. A recording has to hold exactly these. */
export const PATHS = {
  discover: () => 'users;use_login=1/games;game_keys=nfl/leagues',
  settings: (keys: string[]) => `${many(keys)}/settings`,
  rosters: (keys: string[]) => `${many(keys)}/teams/roster`,
  standings: (keys: string[]) => `${many(keys)}/standings`,
  transactions: (keys: string[]) => `${many(keys)}/transactions`,
  scoreboard: (keys: string[], week?: number) =>
    `${many(keys)}/scoreboard${week != null ? `;week=${week}` : ''}`,
  teamWeek: (teamKey: string, week: number) =>
    `team/${teamKey}/roster;week=${week}/players/stats;type=week;week=${week}`,
}

/* -------------------------------------------------------------- schedule */

export type Part =
  | 'discover' | 'settings' | 'rosters' | 'standings'
  | 'transactions' | 'scoreboard' | 'history' | 'teams'

/** In the order a round runs them: each may need what the ones before it read. */
export const PARTS: Part[] = [
  'discover', 'settings', 'rosters', 'standings', 'transactions', 'scoreboard', 'history', 'teams',
]

/**
 * How old each part may get, in minutes, with games on and with none.
 *
 * A live Sunday costs about nine requests every ten minutes — one scoreboard
 * for every league and two lineups for each head-to-head week — which is
 * roughly seven hundred across the day. A Tuesday costs a few dozen.
 */
export const EVERY: Record<Part, { live: number; idle: number }> = {
  discover: { live: 360, idle: 360 },
  settings: { live: 1440, idle: 1440 },
  rosters: { live: 30, idle: 120 },
  standings: { live: 60, idle: 180 },
  transactions: { live: 30, idle: 60 },
  scoreboard: { live: 10, idle: 60 },
  history: { live: 360, idle: 360 },
  teams: { live: 10, idle: 60 },
}

/** After a failure, the soonest a part is tried again — sooner if its own clock says so. */
export const RETRY_AFTER = 15 * 60_000

/**
 * Which parts are due, given when each last succeeded and last failed.
 *
 * A part that failed is not retried on every tick: a request Yahoo refused a
 * minute ago will be refused again, and a round runs every five minutes.
 */
export function due(parts: Partial<Record<Part, PartStatus>>, live: boolean, now: number): Part[] {
  return PARTS.filter((p) => {
    const s = parts[p]
    const every = EVERY[p][live ? 'live' : 'idle'] * 60_000
    if (s?.error && s.tried != null && now - s.tried < Math.min(every, RETRY_AFTER)) return false
    return s?.at == null || now - s.at >= every
  })
}

/* ------------------------------------------------------------------ state */

const STATE = statePath('yahoo-sync.json')

export interface PartStatus {
  /** When it last succeeded. */
  at: number | null
  /** When it was last tried, and what went wrong if it did. */
  tried: number | null
  error: string | null
}

export interface SyncState {
  leagues: Y.YLeague[]
  /** Leagues nobody configured, built from their settings so they can have a session. */
  discovered: LeagueConfig[]
  parts: Partial<Record<Part, PartStatus>>
  /** Per league: my team's key and, in a head-to-head week, his. */
  teamKeys: Record<string, { mine: string | null; theirs: string | null }>
  lastRound: { at: number; ran: Part[]; failed: Part[]; stopped: string | null } | null
}

const blank = (): SyncState => ({ leagues: [], discovered: [], parts: {}, teamKeys: {}, lastRound: null })

export function state(): SyncState {
  if (!existsSync(STATE)) return blank()
  try { return { ...blank(), ...JSON.parse(readFileSync(STATE, 'utf8')) as Partial<SyncState> } } catch { return blank() }
}

function saveState(s: SyncState): void {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 1))
}

/* --------------------------------------------------------------- players */

export interface Resolved { id: PlayerId; name: string; pos: Pos | null }

const SUFFIX = /\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/i

/**
 * Yahoo's position, as a hint rather than a fact.
 *
 * Defenders arrive as 'LB,DE' or 'DB,S', and a two-way player as 'WR,CB'. The
 * hint only narrows a name that matches more than one player — the index falls
 * back to every candidate when the hint matches none — so being approximate
 * here costs nothing and being absent would cost the Mike Williamses.
 */
export function posHint(y: Y.YPlayer): Pos | undefined {
  const d = y.display.toUpperCase().split(',').map((s) => s.trim())
  if (d.includes('DEF')) return 'DST'
  if ((['QB', 'RB', 'WR', 'TE', 'K'] as const).includes(d[0] as any)) return d[0] as Pos
  if (d.includes('LB')) return 'LB'
  if (d.some((x) => ['DL', 'DE', 'DT'].includes(x))) return 'DL'
  if (d.some((x) => ['DB', 'CB', 'S'].includes(x))) return 'DB'
  return undefined
}

/**
 * Yahoo's player, as the app's.
 *
 * By Yahoo's own id first, where the player map carries it — a third of it
 * does, since Sleeper's copy of the id is missing for recent players. Then by
 * name, narrowed by position and club. A name match that already carries a
 * different Yahoo id is a different man with the same name, and is refused.
 * A defence is named by its nickname alone, so it is found by club.
 */
export function resolver(players: Player[]): (y: Y.YPlayer) => Resolved | null {
  const index = new PlayerIndex(players)
  const byYahoo = new Map<string, Player>()
  const defence = new Map<string, Player>()
  for (const p of players) {
    if (p.ids?.yahoo) byYahoo.set(String(p.ids.yahoo), p)
    if (p.pos === 'DST' && p.team) defence.set(p.team.toUpperCase(), p)
  }
  const as = (p: Player): Resolved => ({ id: p.id, name: p.name, pos: p.pos })
  return (y) => {
    const exact = byYahoo.get(y.yahooId)
    if (exact) return as(exact)
    const pos = posHint(y)
    if (pos === 'DST') {
      const d = (y.team && defence.get(y.team)) ?? index.resolve({ name: y.name, pos: 'DST' })
      return d ? as(d) : null
    }
    const hit =
      index.resolve({ name: y.name, pos, team: y.team }) ??
      index.resolve({ name: y.name, pos }) ??
      index.resolve({ name: y.name }) ??
      index.resolve({ name: y.name.replace(SUFFIX, '').trim(), pos })
    if (!hit) return null
    if (hit.ids?.yahoo && String(hit.ids.yahoo) !== y.yahooId) return null
    return as(hit)
  }
}

/* ------------------------------------------------------------ transforms */

/** Slots that do not score. Everything else Yahoo lists is a starting place. */
const RESERVE = new Set(['BN', 'IR', 'IR+', 'NA'])
export const starting = (slot: string | null) => !!slot && !RESERVE.has(slot.toUpperCase())

/**
 * Yahoo's slot name, as this app's configs spell it.
 *
 * Identical but for the defence: Yahoo's DEF is the config's DST. The flexes
 * keep their own names — 'W/R/T', and 'D' for the defenders — because that is
 * what the league itself calls them and what the slot list is built from.
 */
export const slotName = (slot: string | null): string | null =>
  !slot ? null : slot.toUpperCase() === 'DEF' ? 'DST' : slot

type Resolve = (y: Y.YPlayer) => Resolved | null

/** A player the app could not name is still a player: kept with Yahoo's name and a marked id. */
const who = (y: Y.YPlayer, resolve: Resolve) => {
  const r = resolve(y)
  return r ?? { id: `yahoo:${y.yahooId}`, name: y.name, pos: posHint(y) ?? null }
}

export function squadsFrom(teams: Y.YTeam[], resolve: Resolve): leagueStore.Squad[] {
  return teams.map((t) => {
    const players: leagueStore.Squad['players'] = []
    const starters: string[] = []
    const unmatched: string[] = []
    for (const y of t.players) {
      const r = resolve(y)
      if (!r) { unmatched.push(y.name); continue }
      /*
       * No projection. Yahoo's API has none per player — `projected_stats` is
       * refused as an invalid resource and `is_projected=1` is ignored — so
       * whoever reads a squad scores it, once, in one currency for everybody.
       */
      players.push({ id: r.id, name: r.name, pos: r.pos, projected: null, status: y.status, injury: y.injury })
      if (starting(y.slot)) starters.push(r.id)
    }
    return { teamId: t.id, manager: t.manager, name: t.name, players, starters, unmatched }
  })
}

/**
 * Yahoo's transactions as the digest's moves.
 *
 * A trade is split into one move per side, each from that manager's point of
 * view, because the digest asks "who added whom" and a trade answers that
 * twice. No league has made one yet, so this reading of a trade is from the
 * documented shape rather than a recorded one — the add/drop reading beside
 * it is from 154 recorded moves.
 */
export function movesFrom(txs: Y.YTransaction[], managerOf: Map<string, string>, resolve: Resolve): Move[] {
  const out: Move[] = []
  const name = (teamId: string | null) => (teamId && managerOf.get(teamId)) || 'A manager'
  for (const t of txs) {
    if (t.status !== 'successful' || !t.players.length) continue
    const type = (['add', 'drop', 'add/drop', 'trade', 'commish'] as const).find((x) => x === t.type)
    if (!type) continue
    if (type === 'trade') {
      const sides = new Set(t.players.flatMap((p) => [p.fromTeamId, p.toTeamId]).filter(Boolean) as string[])
      for (const side of sides) {
        out.push({
          id: `${t.key}:${side}`, at: t.at, type, manager: name(side), teamId: side,
          added: t.players.filter((p) => p.toTeamId === side).map((p) => who(p.player, resolve)),
          dropped: t.players.filter((p) => p.fromTeamId === side).map((p) => who(p.player, resolve)),
        })
      }
      continue
    }
    const actor = t.players.find((p) => p.kind === 'add')?.toTeamId
      ?? t.players.find((p) => p.kind === 'drop')?.fromTeamId ?? null
    out.push({
      id: t.key, at: t.at, type, manager: name(actor), teamId: actor,
      added: t.players.filter((p) => p.kind === 'add').map((p) => who(p.player, resolve)),
      dropped: t.players.filter((p) => p.kind === 'drop').map((p) => who(p.player, resolve)),
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

/**
 * A finished week, as all-play and the luck split read it.
 *
 * Only once every matchup is final: a week read on a Monday afternoon would
 * otherwise be scored with Monday night still to play. A guillotine week has
 * scores but no draw — its pairings are Yahoo's way of drawing the chopping
 * block, not games — so it gives the week and not the pairs.
 */
export function weekFrom(sb: Y.YScoreboard, guillotine: boolean):
  { week: WeekScores; pairs: [string, string][] | null } | null {
  if (sb.week == null || !sb.matchups.length) return null
  if (sb.matchups.some((m) => m.status !== 'postevent')) return null
  const points = new Map<string, number>()
  for (const m of sb.matchups) for (const s of m.sides) if (s.points != null) points.set(s.teamId, s.points)
  return {
    week: { week: sb.week, teams: [...points].map(([teamId, p]) => ({ teamId, points: p })) },
    pairs: guillotine
      ? null
      : sb.matchups.filter((m) => m.sides.length === 2)
          .map((m) => [m.sides[0].teamId, m.sides[1].teamId] as [string, string]),
  }
}

/** This week so far: every team's points and Yahoo's projection. */
export function currentFrom(sb: Y.YScoreboard, at: number): leagueStore.Current | null {
  if (sb.week == null) return null
  const sides = new Map<string, leagueStore.Current['sides'][number]>()
  for (const m of sb.matchups) {
    for (const s of m.sides) sides.set(s.teamId, { teamId: s.teamId, name: s.name, points: s.points, projected: s.projected })
  }
  return {
    week: sb.week, at,
    status: sb.matchups[0]?.status ?? null,
    sides: [...sides.values()],
    pairs: sb.matchups.filter((m) => m.sides.length === 2)
      .map((m) => [m.sides[0].teamId, m.sides[1].teamId] as [string, string]),
  }
}

/**
 * Yahoo's status codes, in the words the rest of the app uses for a
 * designation — the ones the lineup optimiser and the alert rules read.
 *
 * NA is "Inactive: Coach's Decision or Not on Roster" and CEL the
 * Commissioner Exempt List: neither man plays, which is what NA already means
 * to the optimiser. An unknown code passes through as itself, so a new one
 * shows up on screen rather than being quietly dropped.
 */
export function designationOf(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase()
  if (!c) return null
  const words: Record<string, string> = {
    Q: 'Questionable', D: 'Doubtful', O: 'Out',
    IR: 'IR', 'IR-R': 'IR', 'PUP-R': 'PUP', 'PUP-P': 'PUP', PUP: 'PUP',
    NA: 'NA', CEL: 'NA', SUSP: 'Sus',
  }
  return words[c] ?? code!.trim()
}

/* ------------------------------------------------------ league discovery */

/** Yahoo's flex slots, and who may fill them. */
const FLEXES: Record<string, Pos[]> = {
  'W/R/T': ['RB', 'WR', 'TE'],
  'W/R': ['WR', 'RB'],
  'W/T': ['WR', 'TE'],
  'R/T': ['RB', 'TE'],
  'Q/W/R/T': ['QB', 'RB', 'WR', 'TE'],
  D: ['DB', 'DL', 'LB'],
}
const SLOT_POS: Record<string, Pos> = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DST', DB: 'DB', DL: 'DL', LB: 'LB',
}

/**
 * Yahoo's scoring, in the keys the projections are scored with.
 *
 * By stat id, each checked against the name Yahoo gives it in the league's own
 * settings, so a renumbering cannot quietly score a sack as a reception. Only
 * the rules the hand-written configs carry: offence is read from Sleeper's
 * half-point totals and only the defenders are scored component by component,
 * so a kicker's rules here would be decoration.
 */
const STAT: Record<string, { name: string; key: string; group?: string }> = {
  4: { name: 'Passing Yards', key: 'pass_yd' },
  5: { name: 'Passing Touchdowns', key: 'pass_td' },
  6: { name: 'Interceptions', key: 'pass_int' },
  9: { name: 'Rushing Yards', key: 'rush_yd' },
  10: { name: 'Rushing Touchdowns', key: 'rush_td' },
  11: { name: 'Receptions', key: 'rec' },
  12: { name: 'Receiving Yards', key: 'rec_yd' },
  13: { name: 'Receiving Touchdowns', key: 'rec_td' },
  18: { name: 'Fumbles Lost', key: 'fum_lost' },
  38: { name: 'Tackle Solo', key: 'idp_tkl_solo' },
  39: { name: 'Tackle Assist', key: 'idp_tkl_ast' },
  40: { name: 'Sack', key: 'idp_sack', group: 'DP' },
  41: { name: 'Interception', key: 'idp_int', group: 'DP' },
  42: { name: 'Fumble Force', key: 'idp_ff' },
  43: { name: 'Fumble Recovery', key: 'idp_fum_rec', group: 'DP' },
  44: { name: 'Defensive Touchdown', key: 'idp_td' },
  45: { name: 'Safety', key: 'idp_safe', group: 'DP' },
  46: { name: 'Pass Defended', key: 'idp_pass_def' },
  47: { name: 'Block Kick', key: 'idp_blk_kick', group: 'DP' },
  65: { name: 'Tackles for Loss', key: 'idp_tfl' },
}

export function scoringFrom(s: Y.YSettings): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of s.scored) {
    const known = STAT[x.id]
    if (!known || known.name !== x.name) continue
    if (known.group && x.group && known.group !== x.group) continue
    out[known.key] = x.value
  }
  return out
}

/**
 * A league nobody configured, configured from what Yahoo says about it.
 *
 * The hand-written configs are checked against this in the tests: built from
 * the recorded settings, each of the four comes out with the same slots, bench,
 * reserve and scoring as the file somebody typed in August.
 */
export function configFrom(l: Y.YLeague, s: Y.YSettings, myTeamId: string | null): LeagueConfig {
  const starters: Partial<Record<Pos, number>> = {}
  const flex: FlexSlot[] = []
  let bench = 0
  let ir = 0
  for (const p of s.positions) {
    if (p.pos === 'BN') bench += p.count
    else if (p.pos === 'IR' || p.pos === 'IR+') ir += p.count
    else if (FLEXES[p.pos]) flex.push({ name: p.pos, eligible: FLEXES[p.pos], count: p.count })
    else if (SLOT_POS[p.pos]) starters[SLOT_POS[p.pos]] = (starters[SLOT_POS[p.pos]] ?? 0) + p.count
  }
  const seats = Object.values(starters).reduce((a, n) => a + (n ?? 0), 0) +
    flex.reduce((a, f) => a + f.count, 0) + bench
  const config: LeagueConfig & Record<string, unknown> = {
    id: `yahoo-${l.id}`,
    label: l.name,
    sport: 'nfl',
    platform: 'yahoo',
    leagueKey: l.key,
    teams: l.teams,
    mySlot: null,
    ...(myTeamId ? { myTeamId } : {}),
    starters,
    flex,
    benchSize: bench,
    rounds: seats,
    scoring: scoringFrom(s),
    adjustments: [],
    ...(s.draftTime ? { draftTime: new Date(s.draftTime).toISOString() } : {}),
    feed: 'yahoo-ext',
    leagueId: l.id,
    irSlots: ir,
    ...(l.guillotine ? { format: 'guillotine' } : {}),
    discovered: true,
    startWeek: l.startWeek,
  }
  return config
}

/* ------------------------------------------------------------------ round */

export interface Deps {
  players: Player[]
  /** The leagues somebody configured; everything else Yahoo lists is discovered. */
  configured: LeagueConfig[]
  /** Whether games are on or about to be, which sets how fresh everything must be. */
  live: boolean
  now?: number
  /** Run these whatever their clocks say. */
  force?: Part[]
}

export interface Round {
  ran: Part[]
  failed: { part: Part; error: string }[]
  /** Set when something stopped the whole round: a rate limit, the budget, the connection. */
  stopped: string | null
  discovered: LeagueConfig[]
}

/** One round: every part that is due, in order, each on its own. */
export async function round(deps: Deps): Promise<Round> {
  const now = deps.now ?? Date.now()
  const st = state()
  const todo = [...new Set([...due(st.parts, deps.live, now), ...(deps.force ?? [])])]
    .sort((a, b) => PARTS.indexOf(a) - PARTS.indexOf(b))
  const out: Round = { ran: [], failed: [], stopped: null, discovered: st.discovered }
  if (!todo.length || !api.connected()) return out

  const resolve = resolver(deps.players)
  const configuredKeys = new Set(deps.configured.map((c) => c.leagueKey))

  for (const part of todo) {
    // Nothing to ask about until Yahoo has said which leagues there are.
    if (part !== 'discover' && !st.leagues.length) continue
    const status: PartStatus = st.parts[part] ?? { at: null, tried: null, error: null }
    status.tried = now
    try {
      await run(part, st, { ...deps, now }, resolve, configuredKeys)
      status.at = now
      status.error = null
      out.ran.push(part)
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      status.error = msg
      out.failed.push({ part, error: msg })
      st.parts[part] = status
      if (e instanceof YahooError && e.stopsRound) { out.stopped = msg; break }
    }
    st.parts[part] = status
  }
  st.lastRound = { at: now, ran: out.ran, failed: out.failed.map((f) => f.part), stopped: out.stopped }
  saveState(st)
  out.discovered = st.discovered
  return out
}

async function run(
  part: Part, st: SyncState, deps: Deps & { now: number }, resolve: Resolve, configuredKeys: Set<string>,
): Promise<void> {
  const keys = st.leagues.map((l) => l.key)
  const meta = new Map(st.leagues.map((l) => [l.key, l]))
  const nodes = async (path: string) => Y.leagueNodes(await api.call(path))

  switch (part) {
    case 'discover': {
      const found = Y.parseDiscovery(await api.call(PATHS.discover()))
      // An answer with no leagues in it is not news that every league vanished.
      if (!found.length) throw new Error('Yahoo listed no leagues for this account')
      st.leagues = found
      return
    }

    case 'settings': {
      const discovered: LeagueConfig[] = []
      for (const n of await nodes(PATHS.settings(keys))) {
        const s = Y.parseSettings(n.body)
        const l = meta.get(String(n.meta.league_key))
        if (!s || !l) continue
        leagueStore.record({ yahooLeagueId: l.id, settings: s, guillotine: l.guillotine, name: l.name })
        if (!configuredKeys.has(l.key)) {
          discovered.push(configFrom(l, s, leagueStore.forLeague(l.id)?.myTeamId ?? null))
        }
      }
      st.discovered = discovered
      return
    }

    case 'rosters': {
      for (const n of await nodes(PATHS.rosters(keys))) {
        const l = meta.get(String(n.meta.league_key))
        if (!l) continue
        const teams = Y.parseRosters(n.body)
        const mine = teams.find((t) => t.mine)
        const keysFor = (st.teamKeys[l.key] ??= { mine: null, theirs: null })
        if (mine) keysFor.mine = mine.key
        leagueStore.record({
          yahooLeagueId: l.id,
          myTeamId: mine?.id ?? null,
          squads: squadsFrom(teams, resolve),
          teams: teams.map((t) => ({ teamId: t.id, name: t.name, manager: t.manager })),
          guillotine: l.guillotine,
          name: l.name,
        })
        // A discovered league learns which team is mine the first time rosters are read.
        for (const d of st.discovered) if (d.leagueKey === l.key && mine) d.myTeamId = mine.id
      }
      return
    }

    case 'standings': {
      for (const n of await nodes(PATHS.standings(keys))) {
        const l = meta.get(String(n.meta.league_key))
        if (!l) continue
        const rows = Y.parseStandings(n.body)
        leagueStore.record({ yahooLeagueId: l.id, standings: rows })
        const me = rows.find((r) => r.mine)
        // A guillotine league has no record to stand on; its place is the chop line.
        if (me && !l.guillotine) {
          rosterStore.recordFromApi({
            yahooLeagueId: l.id, teamId: me.teamId,
            standing: {
              wins: me.wins ?? 0, losses: me.losses ?? 0, ties: me.ties ?? 0,
              place: me.rank, pointsFor: me.pointsFor, pointsAgainst: me.pointsAgainst,
            },
          })
        }
      }
      return
    }

    case 'transactions': {
      for (const n of await nodes(PATHS.transactions(keys))) {
        const l = meta.get(String(n.meta.league_key))
        if (!l) continue
        const wide = leagueStore.forLeague(l.id)
        const managerOf = new Map((wide?.teams ?? wide?.squads ?? []).map((t) => [t.teamId, t.manager]))
        leagueStore.record({
          yahooLeagueId: l.id,
          transactions: movesFrom(Y.parseTransactions(n.body), managerOf, resolve),
        })
      }
      return
    }

    case 'scoreboard': {
      for (const n of await nodes(PATHS.scoreboard(keys))) {
        const l = meta.get(String(n.meta.league_key))
        const sb = Y.parseScoreboard(n.body)
        if (!l || !sb) continue
        const current = currentFrom(sb, deps.now)
        leagueStore.record({ yahooLeagueId: l.id, current })
        const keysFor = (st.teamKeys[l.key] ??= { mine: null, theirs: null })
        if (l.guillotine || !keysFor.mine) { keysFor.theirs = null; continue }
        const game = sb.matchups.find((m) => m.sides.some((s) => s.teamKey === keysFor.mine))
        const me = game?.sides.find((s) => s.teamKey === keysFor.mine)
        const him = game?.sides.find((s) => s.teamKey !== keysFor.mine)
        keysFor.theirs = him?.teamKey ?? null
        if (me) {
          rosterStore.recordFromApi({
            yahooLeagueId: l.id, teamId: me.teamId,
            totals: {
              teamName: me.name, opponentName: him?.name ?? null,
              mine: me.points, theirs: him?.points ?? null,
              projectedMine: me.projected, projectedTheirs: him?.projected ?? null,
            },
            week: sb.week,
          })
        }
      }
      return
    }

    case 'history': {
      /*
       * Finished weeks, each read once. A week is asked about for every league
       * that had started by then — asking for a week before a league's first
       * refuses the whole multi-league request.
       */
      const need = new Map<number, string[]>()
      for (const l of st.leagues) {
        const have = new Set((leagueStore.forLeague(l.id)?.weeks ?? []).map((w) => w.week))
        const first = l.startWeek ?? 1
        for (let w = first; w < (l.currentWeek ?? first); w++) {
          if (!have.has(w)) need.set(w, [...(need.get(w) ?? []), l.key])
        }
      }
      for (const [w, ks] of [...need].sort((a, b) => a[0] - b[0])) {
        for (const n of await nodes(PATHS.scoreboard(ks, w))) {
          const l = meta.get(String(n.meta.league_key))
          const sb = Y.parseScoreboard(n.body)
          if (!l || !sb) continue
          const read = weekFrom(sb, l.guillotine)
          if (!read) continue
          const wide = leagueStore.forLeague(l.id)
          const weeks = [...(wide?.weeks ?? []).filter((x) => x.week !== w), read.week]
            .sort((a, b) => a.week - b.week)
          const draw = read.pairs
            ? [...(wide?.draw ?? []).filter((x) => x.week !== w), { week: w, pairs: read.pairs }]
                .sort((a, b) => a.week - b.week)
            : wide?.draw ?? []
          /*
           * And my own lineup that week, once. A finished week never changes,
           * and without it there is no way to ask afterwards whether the
           * points that were lost were ever on the bench.
           *
           * Its own try: the week's scores are the part's job and this is an
           * extra on top, so a lineup that cannot be read costs the grade for
           * one week rather than the standings for every later one.
           */
          const mine = st.teamKeys[l.key]?.mine
          const graded = wide?.mineWeeks ?? []
          let mineWeeks = graded
          if (mine && !graded.some((x) => x.week === w)) {
            const t = await api.call(PATHS.teamWeek(mine, w))
              .then((a) => Y.parseTeamWeek(a))
              .catch((e) => { if (e instanceof YahooError && e.stopsRound) throw e; return null })
            if (t) {
              const starters: string[] = []
              const players: string[] = []
              const points: Record<string, number> = {}
              for (const y of t.players) {
                const r = resolve(y)
                if (!r) continue
                players.push(r.id)
                if (starting(y.slot)) starters.push(r.id)
                if (y.points != null) points[r.id] = y.points
              }
              if (players.length) mineWeeks = [...graded, { week: w, starters, players, points }]
            }
          }
          leagueStore.record({ yahooLeagueId: l.id, weeks, draw, mineWeeks })
        }
      }
      return
    }

    case 'teams': {
      for (const l of st.leagues) {
        const k = st.teamKeys[l.key]
        const week = leagueStore.forLeague(l.id)?.current?.week ?? l.currentWeek
        if (!k?.mine || week == null) continue
        const lineup = async (key: string) => {
          const t = Y.parseTeamWeek(await api.call(PATHS.teamWeek(key, week)))
          if (!t) throw new Error(`no lineup in the answer for ${key}`)
          const ids: PlayerId[] = []
          const starters: PlayerId[] = []
          const live: Record<string, number> = {}
          const slotOf: Record<string, string> = {}
          const unmatched: string[] = []
          for (const y of t.players) {
            const r = resolve(y)
            if (!r) { unmatched.push(y.name); continue }
            ids.push(r.id)
            /*
             * Where he is, not just that he is starting. Yahoo states the slot
             * outright, and it decides who could replace him: three backs on
             * the bench are cover for a flex and no cover at all for a
             * receiver's slot.
             */
            if (starting(y.slot)) {
              starters.push(r.id)
              const name = slotName(y.slot)
              if (name) slotOf[r.id] = name
            }
            if (y.points != null) live[r.id] = y.points
          }
          return { team: t, ids, starters, live, slotOf, unmatched }
        }
        const me = await lineup(k.mine)
        const him = k.theirs && !l.guillotine ? await lineup(k.theirs) : null
        rosterStore.recordFromApi({
          yahooLeagueId: l.id, teamId: me.team.id,
          players: me.ids, starters: me.starters, live: me.live, unmatched: me.unmatched,
          slotOf: me.slotOf,
          week,
          ...(him ? {
            opponent: {
              name: him.team.name, players: him.ids, starters: him.starters,
              live: him.live, projected: {}, slotOf: him.slotOf,
            },
          } : {}),
        })
      }
      return
    }
  }
}

/** Every discovered league's config, for creating sessions before the first round finishes. */
export const discoveredLeagues = (): LeagueConfig[] => state().discovered
