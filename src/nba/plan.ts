/**
 * Everything the basketball draft screen shows, worked out from a draft and
 * the league's numbers. Pure, so the server can call it on every change and
 * the tests can call it on a fixture.
 *
 * The screen answers, in order: is it my turn, who do I take, where is my
 * build going, which builds are still open to me, and who should I be
 * expecting to take over the next few rounds.
 *
 * Paths are worked out by drafting the rest of my picks forward against a room
 * that drafts down Yahoo's ADP — once per candidate build — and scoring each
 * finished roster on all nine categories. That one mechanism says both what a
 * build is worth from here and who it would take at each of my next turns.
 * The room never deviates from ADP and real rooms do, so the targets are the
 * likely shape of a path, not a promise.
 */
import { nextPickFor, overallFor, roundFor, slotFor } from '../kernel/snake.js'
import {
  adviseCategories, advisePoints, baseline, contribution, expectedCats, readBuild, survives, winChances, zero,
  BUILD_FIRM, BUILD_FROM, type AdpSpread, type Advice, type Baseline, type CanTake, type Strength,
} from './draft.js'
import { CATS, categoryZ, effectiveGames, pointsValues, rankBuild, rosterSpots, type Cat, type CatRow, type PointsRow } from './value.js'
import { positionalSlots, stillFeasible, stillToFill } from './lineup.js'
import { startShares, type Calendar } from './starts.js'
import { startingSeats } from './week.js'
import { myPicks, teamsIn, type FeedItem, type StoredDraft } from './session.js'
import type { NbaPlayer } from './types.js'
import type { PrefTag } from './preferences.js'
import type { MockRecord } from './tendencies.js'
import { personKey, type Habit, type OpponentReport } from './opponents.js'

export interface NbaLeague {
  id: string
  label: string
  leagueKey: string
  myTeamName: string
  teams: number
  scoring: 'points' | 'categories'
  points?: Record<string, number>
  roster: Record<string, number>
  /** Older seasons Yahoo's renewal chain does not reach, by league id. */
  history?: { season: string; leagueId: string }[]
  /** How far this league's picks land from ADP, measured on its own drafts. */
  adpSpread?: AdpSpread
  /** Set on a Yahoo mock draft, which borrows a real league's settings for its own temporary league. */
  mock?: { yahooLeagueId: string; baseId: string; apiOk: boolean | null; createdAt: number }
}

/** The builds offered as paths. Pairs are the ones the punt literature and last season's team suggest. */
export const PATHS: { name: string; punt: Cat[] }[] = [
  { name: 'Balanced', punt: [] },
  { name: 'Punt FT%', punt: ['ft'] },
  { name: 'Punt FG%', punt: ['fg'] },
  { name: 'Punt AST', punt: ['ast'] },
  { name: 'Punt TO', punt: ['to'] },
  { name: 'Punt 3PM', punt: ['tpm'] },
  { name: 'Punt PTS', punt: ['pts'] },
  { name: 'Punt AST + TO', punt: ['ast', 'to'] },
  { name: 'Punt FT% + 3PM', punt: ['ft', 'tpm'] },
  { name: 'Punt REB + BLK', punt: ['reb', 'blk'] },
  { name: 'Punt FG% + TO', punt: ['fg', 'to'] },
]

export const CAT_LABEL: Record<Cat, string> = {
  fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO',
}

const nameOfPunt = (punt: Cat[]) =>
  PATHS.find((p) => p.punt.length === punt.length && p.punt.every((c) => punt.includes(c)))?.name ??
  (punt.length ? `Punt ${punt.map((c) => CAT_LABEL[c]).join(' + ')}` : 'Balanced')

/** What a league needs computed once, not on every pick. */
export interface Prepared {
  league: NbaLeague
  rounds: number
  players: Map<string, NbaPlayer>
  adp: (id: string) => number
  positions: (id: string) => string[]
  slots: string[]
  cats?: { rows: (CatRow & { adp: number })[]; byId: Map<string, CatRow & { adp: number }>; base: Baseline; byBuild: Map<string, Map<string, { value: number; rank: number }>> }
  points?: { rows: (PointsRow & { adp: number })[]; byId: Map<string, PointsRow & { adp: number }> }
  adpOrder: string[]
  /** Games a player's team plays in this league's playoff weeks, where the schedule is known. */
  playoff: (id: string) => number | null
  /** What most teams play in those weeks, so a number can be read as good or bad. */
  playoffNorm: number | null
  /** For a player starting the season hurt: when he is back and what that leaves. */
  returnNote: (id: string) => string | null
  /** The season's game days (sampled), for counting starts; null without a schedule. */
  calendar: Calendar | null
}

/** Where a player's expected return comes from: a date you set, or CBS's injury report. */
export interface Availability {
  returnDate: string | null
  outForSeason: boolean
  source: 'you' | 'cbs'
  text: string
}

export interface InjuryInputs {
  returns: Map<string, Availability>
  /** Team code → every game date, from the schedule. */
  teamDates: Record<string, string[]>
  /** Today, as YYYY-MM-DD; games before it are not counted. */
  today: string
}

/**
 * CBS gives the earliest a player is expected back ("out until at least Jan 2"),
 * and returns slip more often than they come early, so its dates are pushed
 * back this many days. A date you set yourself is taken as given.
 */
export const RETURN_SLIP_DAYS = 10

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * Games for a player who starts the season hurt: his team's games from the day
 * he is back, at his usual rate of availability, never more than he was
 * projected for a full season. Out for the season is no games at all.
 */
export function gamesAfterReturn(p: NbaPlayer, av: Availability, teamDates: Record<string, string[]>, today: string): { gp: number; note: string } {
  const base = effectiveGames(p).gp
  if (av.outForSeason) return { gp: 0, note: 'Out for the season' }
  if (!av.returnDate) return { gp: base, note: av.text }
  const back = av.source === 'cbs' ? addDays(av.returnDate, RETURN_SLIP_DAYS) : av.returnDate
  const from = back > today ? back : today
  const left = (teamDates[p.team ?? ''] ?? []).filter((d) => d >= from).length
  const rate = Math.min(0.95, Math.max(0.6, p.durability.gpShare ?? 0.85))
  const gp = Math.min(base, left * rate)
  const why = av.source === 'you' ? 'your date' : `CBS: at least ${shortDate(av.returnDate)}`
  return { gp, note: `Back ~${shortDate(from)} (${why}) · ${Math.round(gp)} games` }
}

/** Team code → games in each league's playoff weeks (data/nba/teams.json). */
export type PlayoffSchedule = Record<string, Record<string, number>>

/** The real league whose schedule a test or mock league borrows. */
const scheduleKey = (league: NbaLeague) => league.mock?.baseId ?? league.id.replace(/-test$/, '')

/**
 * The nine-category model is built for Yahoo's standard nine. A league that
 * scores anything else would be valued wrongly without a sound, so it fails
 * loudly instead; same for a points league with a stat the projections lack.
 */
export function checkScoring(league: NbaLeague & { categories?: string[] }) {
  if (league.scoring === 'categories') {
    const want = ['fg%', 'ft%', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
    const have = (league.categories ?? want).map((c) => c.toLowerCase())
    if (have.length !== want.length || want.some((c) => !have.includes(c))) {
      throw new Error(`${league.id} scores ${have.join(', ')}; the category model only knows Yahoo's standard nine`)
    }
  } else {
    const known = ['pts', 'reb', 'ast', 'stl', 'blk', 'to', 'tpm']
    const extra = Object.keys(league.points ?? {}).filter((k) => !known.includes(k))
    if (extra.length) throw new Error(`${league.id} scores ${extra.join(', ')}, which the points model does not project`)
  }
}

export function prepare(
  league: NbaLeague, rawPlayers: NbaPlayer[], noise: Record<Cat, number>, adpFor: (p: NbaPlayer) => number,
  schedule: PlayoffSchedule = {}, injuries: InjuryInputs | null = null,
): Prepared {
  checkScoring(league)
  // A player starting the season hurt is valued on the games he will be back for.
  const notes = new Map<string, string>()
  const players = !injuries ? rawPlayers : rawPlayers.map((p) => {
    const av = injuries.returns.get(p.id)
    if (!av || !p.projection) return p
    const r = gamesAfterReturn(p, av, injuries.teamDates, injuries.today)
    notes.set(p.id, r.note)
    return { ...p, projection: { ...p.projection, gp: r.gp, gpSource: 'injury' as const } }
  })
  const byId = new Map(players.map((p) => [p.id, p]))
  const adp = (id: string) => adpFor(byId.get(id)!)
  const rounds = rosterSpots(league.roster)
  const positions = (id: string) => byId.get(id)?.yahoo?.positions ?? byId.get(id)?.positions ?? []
  const key = scheduleKey(league)
  const games = Object.values(schedule).map((t) => t[key]).filter((n): n is number => n != null).sort((a, b) => a - b)
  const playoff = (id: string) => {
    const team = byId.get(id)?.team
    return team && schedule[team]?.[key] != null ? schedule[team][key] : null
  }
  const prepared: Prepared = {
    league, rounds, players: byId, adp, positions, slots: positionalSlots(league.roster), adpOrder: [],
    playoff, playoffNorm: games.length ? games[Math.floor(games.length / 2)] : null,
    returnNote: (id: string) => notes.get(id) ?? null,
    calendar: injuries ? calendarOf(injuries.teamDates) : null,
  }
  if (league.scoring === 'categories') {
    const rows = categoryZ(players, league).map((r) => ({ ...r, adp: adp(r.id) }))
    const base = baseline(rows, league.teams, rounds, noise)
    prepared.cats = { rows, byId: new Map(rows.map((r) => [r.id, r])), base, byBuild: new Map() }
    prepared.adpOrder = [...rows].sort((a, b) => a.adp - b.adp).map((r) => r.id)
  } else {
    const rows = pointsValues(players, league as any).rows.map((r) => ({ ...r, adp: adp(r.id) }))
    prepared.points = { rows, byId: new Map(rows.map((r) => [r.id, r])) }
    prepared.adpOrder = [...rows].sort((a, b) => a.adp - b.adp).map((r) => r.id)
  }
  return prepared
}

/** Every fourth game day of the season, from each team's dates: enough to count starts. */
function calendarOf(teamDates: Record<string, string[]>): Calendar {
  const byDate = new Map<string, Set<string>>()
  for (const [team, dates] of Object.entries(teamDates)) for (const d of dates) (byDate.get(d) ?? byDate.set(d, new Set()).get(d)!).add(team)
  const dates = [...byDate.keys()].sort()
  return { days: dates.filter((_, i) => i % 4 === 0).map((d) => byDate.get(d)!) }
}

/** A fantasy season is about 23.4 weeks of games: 82 over three and a half a week. */
const SEASON_WEEKS = 23.4

export interface RoomRow {
  seat: number
  manager: string | null
  mine: boolean
  picks: number
  /** Points leagues: fantasy points a week from the games the roster would start. */
  pointsWeek: number | null
  value: number | null
  fpSeason: number | null
  /** The average points a game of the roster's best lineup's worth of players: a full night. */
  fpNight: number | null
  fpMin: number | null
  /** Categories leagues: categories a week against an average team with as many picks. */
  catsWeek: number | null
  /** What the rank is on: the same measure over the rounds every team has finished, so a pick in hand is not a lead. */
  rankedOn: number | null
  rank: number
}

/**
 * Every team in the room, measured from its own picks so far, as the draft
 * goes. Points: what a week of starts scores, with value, season points, a
 * full night's points a game and points a minute beside it. Categories: the
 * categories a week the roster wins against an average team.
 */
export function liveRoom(prep: Prepared, d: StoredDraft, teams: number, mySlot: number | null): RoomRow[] {
  const bySeat = new Map<number, string[]>()
  for (const x of d.picks) {
    const seat = slotFor(x.overall, teams)
    ;(bySeat.get(seat) ?? bySeat.set(seat, []).get(seat)!).push(x.playerId)
  }
  const seats = startingSeats(prep.league.roster)
  // Every team has at least this many picks: the rounds the whole room has finished.
  const full = Math.min(...[...bySeat.values()].map((ids) => ids.length), ...(bySeat.size < teams ? [0] : []))
  const headline = (ids: string[]): number => {
    if (prep.points) {
      const rs = ids.map((id) => prep.points!.byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
      const share = prep.calendar
        ? startShares(rs.map((r) => ({ id: r.id, positions: seatPositionsOf(prep.positions(r.id)), team: prep.players.get(r.id)?.team ?? null, worth: r.fpg })), seats, prep.calendar)
        : new Map<string, number>()
      return rs.reduce((n, r) => n + r.fpg * r.games.gp * (share.get(r.id) ?? 1), 0) / SEASON_WEEKS
    }
    return ids.length ? expectedCats(strengthOf(prep, ids), ids.length, prep.cats!.base) : 0
  }
  const rows: RoomRow[] = [...bySeat.entries()].map(([seat, ids]) => {
    const base = { seat, manager: d.managers?.[seat - 1] ?? null, mine: seat === mySlot, picks: ids.length, rank: 0, rankedOn: full > 0 ? headline(ids.slice(0, full)) : null }
    if (prep.points) {
      const rs = ids.map((id) => prep.points!.byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
      const share = prep.calendar
        ? startShares(rs.map((r) => ({ id: r.id, positions: seatPositionsOf(prep.positions(r.id)), team: prep.players.get(r.id)?.team ?? null, worth: r.fpg })), seats, prep.calendar)
        : new Map<string, number>()
      const mins = rs.reduce((n, r) => n + (prep.players.get(r.id)?.projection?.perGame.min ?? 0), 0)
      const top = [...rs].sort((a, b) => b.fpg - a.fpg).slice(0, seats.length)
      return {
        ...base,
        pointsWeek: rs.reduce((n, r) => n + r.fpg * r.games.gp * (share.get(r.id) ?? 1), 0) / SEASON_WEEKS,
        value: rs.reduce((n, r) => n + r.value, 0),
        fpSeason: rs.reduce((n, r) => n + r.season, 0),
        fpNight: top.length ? top.reduce((n, r) => n + r.fpg, 0) / top.length : null,
        fpMin: mins > 0 ? rs.reduce((n, r) => n + r.fpg, 0) / mins : null,
        catsWeek: null,
      }
    }
    return { ...base, pointsWeek: null, value: null, fpSeason: null, fpNight: null, fpMin: null, catsWeek: expectedCats(strengthOf(prep, ids), ids.length, prep.cats!.base) }
  }).sort((a, b) => (b.rankedOn ?? b.pointsWeek ?? b.catsWeek ?? 0) - (a.rankedOn ?? a.pointsWeek ?? a.catsWeek ?? 0))
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

const SEAT_POS = new Set(['PG', 'SG', 'SF', 'PF', 'C'])
function seatPositionsOf(eligible: string[]): string[] {
  const out = new Set<string>()
  for (const e of eligible) {
    if (SEAT_POS.has(e)) out.add(e)
    if (e === 'G') { out.add('PG'); out.add('SG') }
    if (e === 'F') { out.add('SF'); out.add('PF') }
  }
  return [...out]
}

/** Season value and rank of every player under one build, cached per build. */
function buildValues(prep: Prepared, punt: Cat[]) {
  const key = [...punt].sort().join('+')
  const cache = prep.cats!.byBuild
  if (!cache.has(key)) {
    cache.set(key, new Map(rankBuild(prep.cats!.rows, prep.league, punt).map((r) => [r.id, { value: r.value, rank: r.rank }])))
  }
  return cache.get(key)!
}

/**
 * A player whose rank jumps this far under one build is drafted for that build:
 * Giannis is 37th balanced and 4th punting free throws, which is the price the
 * expert boards quote. Shown beside the balanced rank, never instead of it.
 */
export const BUILD_JUMP = 20

export interface BestBuild { name: string; rank: number; balanced: number }

/** The build a player is worth most in, where it is worth a good deal more than balanced. */
export function bestBuildOf(prep: Prepared, id: string): BestBuild | null {
  if (!prep.cats) return null
  const balanced = buildValues(prep, []).get(id)?.rank
  if (balanced == null) return null
  let best: BestBuild | null = null
  for (const path of PATHS.slice(1)) {
    const rank = buildValues(prep, path.punt).get(id)?.rank
    if (rank != null && (!best || rank < best.rank)) best = { name: path.name, rank, balanced }
  }
  return best && balanced - best.rank >= BUILD_JUMP && best.rank <= 150 ? best : null
}

export interface BoardRow {
  id: string
  name: string
  team: string | null
  positions: string[]
  gp: number
  adp: number | null
  yahooRank: number | null
  value: number
  rank: number
  /** Season-weighted contribution per category (categories leagues). */
  contrib?: Record<Cat, number>
  /** Fantasy points per game (points leagues). */
  fpg?: number
  /** Categories leagues: the build he ranks far higher in, if there is one. */
  bestBuild?: BestBuild | null
  /** Fantasy points per projected minute (points leagues): who scores in the minutes he gets. */
  fpMin?: number | null
  /** Fantasy points over the season: per game times the games he is expected to play (points leagues). */
  fpSeason?: number
  survives: number | null
  tag: PrefTag | null
  injury: string | null
  /** Games in this league's playoff weeks. */
  playoff: number | null
  /** When a player starting hurt is expected back, and the games that leaves. */
  returnNote: string | null
  takenAt: number | null
  takenBy: string | null
  mine: boolean
}

export interface PathView {
  name: string
  punt: Cat[]
  expected: number
  locked: boolean
  leading: boolean
  /** Who this path takes at each of my next picks, in the forward draft. */
  plan: { overall: number; round: number; id: string; name: string; positions: string[] }[]
}

export interface DraftView {
  league: { id: string; label: string; scoring: NbaLeague['scoring']; teams: number; rounds: number; slot: number | null; slotSource: StoredDraft['slotSource']; myTeamName: string }
  clock: { overall: number; round: number; onClock: boolean; myNext: number | null; picksUntil: number | null; done: boolean }
  /**
   * Two picks out or on the clock: who to have in Yahoo's queue, best first, so a timeout takes the advice.
   * Not the off-clock cards: those leave out anyone likely gone, and when one of them falls he is the pick.
   * Ranked as if on the clock, Yahoo's autodraft skipping whoever has gone, the first left was the advice's
   * own pick in 99% of simulated turns (Hoops and Harker); the off-clock cards, 42-45%.
   */
  queue: { id: string; name: string }[] | null
  /** Yahoo's pick clock read off the draft room by the extension (server adds it; absent without the extension). */
  yahooClock?: { seconds: number; at: number } | null
  sensor: StoredDraft['sensor']
  roster: { id: string; name: string; team: string | null; positions: string[]; overall: number; round: number }[]
  /** Positional seats still to fill, and which seats could be the open ones. */
  stillToFill: { count: number; options: string[] }
  build: null | {
    stage: 'open' | 'leaning' | 'firm'
    buildFrom: number
    buildFirm: number
    win: Record<Cat, number> | null
    punting: Cat[]
    edge: Cat[]
    strong: Cat[]
    locks: Cat[]
    expected: number | null
  }
  advice: (Advice & { team: string | null; positions: string[]; tag: PrefTag | null; canWait: boolean; contrib?: Record<Cat, number>; fpg?: number; gp: number; playoff: number | null; tiebreak?: boolean; returnNote: string | null; there: number | null; thenName: string | null; mates: string[]; bestBuild: BestBuild | null
    /** Which of my roster's weak categories he would help, from my first pick on. */
    fits: Cat[]
    /** Which of its strong ones he would add to: leaning in rather than covering. */
    stacks: Cat[]
    /** Which of my close categories he would cost me: the costs that matter this draft. */
    hurts: Cat[]
    /** On the cards only: my weekly win chance in each category with him added, for previewing on the build tiles. */
    preview?: Record<Cat, number> })[]
  /**
   * The three cards: the best players to take with this pick. A player the
   * room will very likely leave until my next turn is not an option for this
   * pick — taking him spends it on someone I can have later — so he goes to
   * `canWait` instead, unless there are not three who will be gone.
   */
  takeNow: DraftView['advice']
  /** Strong players likely still there at my next turn: the plan's next pick. */
  canWait: { name: string; survives: number }[]
  /** When the first choices are too close to call and the playoff schedule separates them. */
  playoffNote: string | null
  /** Every team in the room, measured from its picks so far; null before any pick. */
  liveRoom: RoomRow[] | null
  /** My roster's close categories (35-65%), nearest a coin flip first, and whose they are ("Shai's" after one pick). */
  weakSpots: { cats: Cat[]; whose: string } | null
  /** Its strongest: what a pick could stack instead, for a build that leans into them. */
  strongSpots: Cat[]
  playoffNorm: number | null
  /** How many players are on the never list, so an empty one is noticed. */
  neverCount: number
  paths: PathView[]
  ahead: { overall: number; round: number; players: { id: string; name: string; team: string | null; positions: string[]; survives: number; planned: boolean }[] }[]
  aheadBuild: string
  board: BoardRow[]
  log: { overall: number; round: number; name: string; manager: string | null; mine: boolean }[]
  feed: FeedItem[]
  /** The picks between now and my next turn: who makes them, and what their history says about them. */
  pickingBefore: { overall: number; round: number; manager: string | null; habits: Habit[]; seasons: number }[]
  /** Whether the league's history has been read; null for a mock, which has no league-mates. */
  history: null | { seasons: number; consistent: string[] }
  /** Once my roster is full: how it came out, and where I went my own way. */
  review: null | {
    expected: number | null
    win: Record<Cat, number> | null
    punting: Cat[]
    value: number | null
    followed: number
    advisedPicks: number
    departures: { round: number; took: string; advised: string }[]
    /**
     * Every team's draft on the same yardstick as mine, once every pick is in:
     * expected categories a week against an average team, or season value.
     */
    room: { seat: number; manager: string | null; score: number; mine: boolean; rank: number; picks: number; of: number }[] | null
  }
  mock: NbaLeague['mock'] | null
}

/** Where my roster finished in the room: on the review's measure, and on season points in a points league. */
function placeOf(prep: Prepared, d: StoredDraft, teams: number, rounds: number): { result: number; fpSeason: number | null; of: number } | null {
  if (d.slot == null) return null
  const room = roomOf(prep, d, teams, d.slot, rounds)
  const result = room.find((r) => r.mine)?.rank
  if (result == null) return null
  let fpSeason: number | null = null
  if (prep.points) {
    const totals = new Map<number, number>()
    for (const x of d.picks) {
      const seat = slotFor(x.overall, teams)
      totals.set(seat, (totals.get(seat) ?? 0) + (prep.points.byId.get(x.playerId)?.season ?? 0))
    }
    const mine = totals.get(d.slot) ?? 0
    fpSeason = 1 + [...totals.values()].filter((t) => t > mine).length
  }
  return { result, fpSeason, of: room.length }
}

/** How every team's draft came out, measured as mine is. */
export function roomOf(prep: Prepared, d: StoredDraft, teams: number, mySlot: number, rounds: number): NonNullable<NonNullable<DraftView['review']>['room']> {
  const bySeat = new Map<number, string[]>()
  for (const x of d.picks) {
    const seat = slotFor(x.overall, teams)
    ;(bySeat.get(seat) ?? bySeat.set(seat, []).get(seat)!).push(x.playerId)
  }
  const rows = [...bySeat.entries()].map(([seat, ids]) => {
    const score = prep.cats
      ? expectedCats(strengthOf(prep, ids), ids.length, prep.cats.base)
      : ids.reduce((n, id) => n + (prep.points!.byId.get(id)?.value ?? 0), 0)
    return { seat, manager: d.managers?.[seat - 1] ?? null, score, mine: seat === mySlot, rank: 0, picks: ids.length, of: rounds }
  }).sort((a, b) => b.score - a.score)
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

/**
 * Fewer expected games than this and a player is never advised. Value is
 * measured over the games a player plays, so a man out for the season is
 * worth exactly the replacement line — nought — and late in a draft, when
 * everyone left is below the line, nought outranks them all. He stays on the
 * board, with his injury note; he is just never the pick.
 */
export const MIN_GAMES = 10

const gamesOf = (prep: Prepared, id: string) => prep.cats?.byId.get(id)?.games.gp ?? prep.points?.byId.get(id)?.games.gp ?? 0

function canTakeFor(prep: Prepared, mine: string[], tags: Map<string, PrefTag>): CanTake {
  const have = mine.map(prep.positions)
  return (id, after) => {
    if (tags.get(id) === 'never') return false
    if (gamesOf(prep, id) < MIN_GAMES) return false
    const roster = after ? [...have, prep.positions(after)] : have
    return stillFeasible(roster, prep.positions(id), prep.slots, prep.rounds - roster.length - 1)
  }
}

function strengthOf(prep: Prepared, ids: string[]): Strength {
  return ids.reduce((s, id) => {
    const r = prep.cats!.byId.get(id)
    if (!r) return s
    const c = contribution(r)
    return Object.fromEntries(CATS.map((k) => [k, s[k] + c[k]])) as Strength
  }, zero())
}

/**
 * The rest of my draft, played forward: the room takes the lowest ADP left,
 * I take what the advice says under `punt`. Returns my future picks and the
 * finished roster.
 */
function forward(prep: Prepared, taken: Set<string>, mine: string[], slot: number, from: number, punt: Cat[], tags: Map<string, PrefTag>) {
  const teams = prep.league.teams
  const gone = new Set(taken)
  const roster = [...mine]
  const plan: { overall: number; id: string }[] = []
  const last = teams * prep.rounds
  let cursor = 0
  for (let overall = from; overall <= last && roster.length < prep.rounds; overall++) {
    let id: string | undefined
    if (slotFor(overall, teams) === slot) {
      const spot = { teams, rounds: prep.rounds, slot, overall, spread: prep.league.adpSpread }
      const canTake = canTakeFor(prep, roster, tags)
      const advice = prep.cats
        ? adviseCategories(prep.cats.rows.filter((r) => !gone.has(r.id)), roster.map((x) => prep.cats!.byId.get(x)!).filter(Boolean), spot, prep.cats.base,
          { shortlist: 6, lookahead: 10, canTake, ignore: punt, neutralUntil: punt.length ? 0 : BUILD_FROM })
        : advisePoints(prep.points!.rows.filter((r) => !gone.has(r.id)), spot, 6, canTake)
      id = advice[0]?.id
      if (id) { roster.push(id); plan.push({ overall, id }) }
    } else {
      while (cursor < prep.adpOrder.length && gone.has(prep.adpOrder[cursor])) cursor++
      id = prep.adpOrder[cursor]
    }
    if (id) gone.add(id)
  }
  return { plan, roster }
}

export function buildView(prep: Prepared, d: StoredDraft, tags: Map<string, PrefTag>, opponents: OpponentReport | null = null): DraftView {
  const L = prep.league
  const teams = teamsIn(d, L.teams)
  const rounds = prep.rounds
  const takenAt = new Map(d.picks.map((p) => [p.playerId, p]))
  const taken = new Set(takenAt.keys())
  const overall = (d.picks.at(-1)?.overall ?? 0) + 1
  const done = overall > teams * rounds
  const slot = d.slot
  const mineP = slot == null ? [] : myPicks(d, teams, slotFor)
  const mine = mineP.map((p) => p.playerId)
  const onClock = !done && slot != null && slotFor(overall, teams) === slot
  const myNext = slot == null || done ? null : nextPickFor(slot, teams, rounds, overall - 1)
  const nextAfter = slot == null || myNext == null ? null : nextPickFor(slot, teams, rounds, myNext)
  const p = (id: string) => prep.players.get(id)!

  const canTake = canTakeFor(prep, mine, tags)
  const spot = myNext == null ? null : { teams, rounds, slot: slot!, overall: myNext, spread: prep.league.adpSpread }

  // ── Build ──
  let build: DraftView['build'] = null
  if (prep.cats) {
    const s = strengthOf(prep, mine)
    const read = readBuild(s, mine.length, prep.cats.base)
    const win = mine.length ? winChances(s, mine.length, prep.cats.base) : null
    // A punt is read under 35% but only dropped above 42%, so a category wobbling
    // round the line does not flip the build back and forth from pick to pick.
    const sticky = read.stage === 'open' || !win ? [] : CATS.filter((c) => win[c] < 0.35 || ((d.lastPunting ?? []).includes(c) && win[c] < 0.42))
    build = {
      stage: read.stage, buildFrom: BUILD_FROM, buildFirm: BUILD_FIRM,
      // Shown from the first pick: a plain fact about the roster so far. The punt read still waits (BUILD_FROM).
      win,
      punting: sticky,
      edge: read.stage === 'open' || !win ? [] : CATS.filter((c) => win[c] >= 0.35 && win[c] < 0.5),
      strong: read.stage === 'open' || !win ? [] : CATS.filter((c) => win[c] >= 0.65),
      locks: d.locks,
      expected: read.stage === 'open' ? null : expectedCats(s, mine.length, prep.cats.base),
    }
  }

  // ── My roster's weak spots: what a pick could cover, from the first pick on ──
  let weakSpots: DraftView['weakSpots'] = null
  let strongSpots: Cat[] = []
  if (prep.cats && mine.length) {
    const w = winChances(strengthOf(prep, mine), mine.length, prep.cats.base)
    const live = CATS.filter((c) => !d.locks.includes(c))
    // Close: where a pick moves the week most — near a coin flip, on either side. Under 35% is mostly lost, over 65% mostly won.
    const cats = live.filter((c) => w[c] >= CLOSE_LOW && w[c] < CLOSE_HIGH).sort((a, b) => Math.abs(w[a] - 0.5) - Math.abs(w[b] - 0.5)).slice(0, 4)
    strongSpots = live.filter((c) => w[c] >= CLOSE_HIGH).sort((a, b) => w[b] - w[a]).slice(0, 3)
    const first = p(mine[0]).name.split(' ')
    weakSpots = cats.length ? { cats, whose: mine.length === 1 ? `${first[first.length - 1]}'s` : 'your' } : null
  }
  // Players I already have from his NBA team: they share his nights. Information, not a rule: in simulated
  // seasons neither avoiding teammates nor breaking coin flips away from them changed weeks won (2026-10-05).
  const matesOf = (id: string): string[] => {
    const t = p(id).team
    return t ? mine.filter((m) => p(m).team === t).map((m) => p(m).name) : []
  }
  const fitsOf = (contrib: Record<Cat, number> | undefined): Cat[] =>
    weakSpots && contrib ? weakSpots.cats.filter((c) => contrib[c] >= FIT_MIN) : []
  const stacksOf = (contrib: Record<Cat, number> | undefined): Cat[] =>
    contrib ? strongSpots.filter((c) => contrib[c] >= FIT_MIN) : []
  const hurtsOf = (contrib: Record<Cat, number> | undefined): Cat[] =>
    weakSpots && contrib ? weakSpots.cats.filter((c) => contrib[c] <= -FIT_MIN) : []

  // ── Advice ──
  let advice: DraftView['advice'] = []
  let playoffNote: string | null = null
  if (spot) {
    // Off the clock the question is who will be there at my pick, so anyone more likely gone than not is left out.
    const there = (id: string) => onClock || survives(prep.adp(id), myNext!, prep.league.adpSpread, overall) >= 0.5
    const raw = prep.cats
      ? adviseCategories(prep.cats.rows.filter((r) => !taken.has(r.id) && there(r.id)), mine.map((id) => prep.cats!.byId.get(id)!).filter(Boolean), spot, prep.cats.base,
        // A lock is a build you have declared: from then on the roster is read as it is.
        { canTake, neutralUntil: d.locks.length ? 0 : BUILD_FROM, ignore: d.locks })
      : advisePoints(prep.points!.rows.filter((r) => !taken.has(r.id) && there(r.id)), spot, 25, canTake)
    // Fifteen, though the screen shows six: comparing mocks needs the score of whoever I took instead.
    advice = raw.slice(0, 15).map((a) => ({
      ...a, team: p(a.id).team, positions: prep.positions(a.id), tag: tags.get(a.id) ?? null,
      // "There next time" is the turn after this one; a player who will very likely still be there can wait.
      // With that turn straight after this one (a back-to-back at the end of a round), everyone will be.
      survives: nextAfter == null ? 0 : nextAfter === myNext! + 1 ? 1 : survives(prep.adp(a.id), nextAfter, prep.league.adpSpread, myNext!),
      there: onClock ? null : survives(prep.adp(a.id), myNext!, prep.league.adpSpread, overall),
      canWait: nextAfter != null && (nextAfter === myNext! + 1 || survives(prep.adp(a.id), nextAfter, prep.league.adpSpread, myNext!) >= 0.6),
      thenName: a.then ? p(a.then).name : null,
      mates: matesOf(a.id),
      contrib: prep.cats ? contribution(prep.cats.byId.get(a.id)!) : undefined,
      fpg: prep.points?.byId.get(a.id)?.fpg,
      gp: (prep.cats?.byId.get(a.id)?.games.gp ?? prep.points?.byId.get(a.id)?.games.gp) ?? 0,
      playoff: prep.playoff(a.id),
      returnNote: prep.returnNote(a.id),
      bestBuild: bestBuildOf(prep, a.id),
      fits: prep.cats ? fitsOf(contribution(prep.cats.byId.get(a.id)!)) : [],
      stacks: prep.cats ? stacksOf(contribution(prep.cats.byId.get(a.id)!)) : [],
      hurts: prep.cats ? hurtsOf(contribution(prep.cats.byId.get(a.id)!)) : [],
    }))
  }

  // ── Paths and targets ahead ──
  const paths: PathView[] = []
  if (slot != null && !done) {
    const candidates = prep.cats ? PATHS.map((x) => x.punt) : [[]]
    if (prep.cats && d.locks.length && !candidates.some((c) => c.length === d.locks.length && c.every((x) => d.locks.includes(x)))) candidates.push(d.locks)
    for (const punt of candidates) {
      const f = forward(prep, taken, mine, slot, overall, punt, tags)
      const expected = prep.cats
        ? expectedCats(strengthOf(prep, f.roster), f.roster.length, prep.cats.base)
        : f.roster.reduce((n, id) => n + (prep.points!.byId.get(id)?.value ?? 0), 0)
      const locked = d.locks.length > 0 && punt.length === d.locks.length && punt.every((c) => d.locks.includes(c))
      paths.push({
        name: prep.cats ? nameOfPunt(punt) : 'Best value', punt, expected, locked, leading: false,
        plan: f.plan.map((x) => ({ overall: x.overall, round: roundFor(x.overall, teams), id: x.id, name: p(x.id).name, positions: prep.positions(x.id) })),
      })
    }
    paths.sort((a, b) => b.expected - a.expected)
    if (paths[0]) paths[0].leading = true
  }

  // Targets over the next five turns, for the locked build, else the leading path.
  const active = paths.find((x) => x.locked) ?? paths[0] ?? null
  const ahead: DraftView['ahead'] = []
  if (active && slot != null) {
    const planned = new Map(active.plan.map((x) => [x.overall, x.id]))
    const values = prep.cats ? buildValues(prep, active.punt) : null
    const valueOf = (id: string) => (values ? values.get(id)?.value : prep.points!.byId.get(id)?.value) ?? -Infinity
    // A player the plan takes at a later pick is not offered as an alternative at an earlier one.
    const used = new Set<string>(active.plan.map((x) => x.id))
    for (const x of active.plan.slice(1, 6)) {
      const pool = (prep.cats ? prep.cats.rows : prep.points!.rows)
        .filter((r) => !taken.has(r.id) && !used.has(r.id) && tags.get(r.id) !== 'never')
        .map((r) => ({ id: r.id, s: survives(prep.adp(r.id), x.overall, prep.league.adpSpread, overall) }))
        .filter((r) => r.s >= 0.35 && r.s < 0.97)
        .sort((a, b) => valueOf(b.id) - valueOf(a.id))
        .slice(0, 4)
      const plannedId = planned.get(x.overall)!
      const list = [{ id: plannedId, s: survives(prep.adp(plannedId), x.overall, prep.league.adpSpread, overall) }, ...pool.filter((r) => r.id !== plannedId).slice(0, 3)]
      list.forEach((r) => used.add(r.id))
      ahead.push({
        overall: x.overall, round: x.round,
        players: list.map((r) => ({ id: r.id, name: p(r.id).name, team: p(r.id).team, positions: prep.positions(r.id), survives: r.s, planned: r.id === plannedId })),
      })
    }
  }

  // ── Board ──
  const boardBuild = prep.cats ? (d.locks.length ? d.locks : active?.punt ?? []) : []
  const values = prep.cats ? buildValues(prep, boardBuild) : null
  const board: BoardRow[] = (prep.cats ? prep.cats.rows : prep.points!.rows).map((r) => {
    const pl = p(r.id)
    const v = values ? values.get(r.id)! : { value: (r as PointsRow).value, rank: (r as PointsRow).rank }
    const t = takenAt.get(r.id)
    return {
      id: r.id, name: pl.name, team: pl.team, positions: prep.positions(r.id),
      gp: r.games.gp, adp: pl.yahoo?.adp ?? null, yahooRank: pl.yahoo?.rank ?? null,
      value: v.value, rank: v.rank,
      contrib: prep.cats ? contribution(r as CatRow) : undefined,
      fpg: prep.points ? (r as PointsRow).fpg : undefined,
      bestBuild: bestBuildOf(prep, r.id),
      fpMin: prep.points ? ((pl.projection?.perGame.min ?? 0) > 0 ? (r as PointsRow).fpg / pl.projection!.perGame.min : null) : undefined,
      fpSeason: prep.points ? (r as PointsRow).season : undefined,
      // Chance he lasts to the next decision: the pick after this one when I am on the clock.
      survives: (onClock ? nextAfter : myNext) == null ? null : onClock && nextAfter === overall + 1 ? 1 : survives(prep.adp(r.id), (onClock ? nextAfter : myNext)!, prep.league.adpSpread, overall),
      tag: tags.get(r.id) ?? null,
      injury: pl.injury?.status ?? null,
      playoff: prep.playoff(r.id),
      returnNote: prep.returnNote(r.id),
      takenAt: t?.overall ?? null, takenBy: t?.manager ?? null,
      mine: mine.includes(r.id),
    }
  }).sort((a, b) => a.rank - b.rank).slice(0, 320)

  // ── Review, once the roster is full ──
  let review: DraftView['review'] = null
  if (mine.length >= rounds) {
    // What the advice said, less anyone since put on the never list: advice you would never
    // take is not advice, and judging a pick against it says nothing (football's rule too).
    const advised: Record<number, string> = {}
    for (const x of mineP) {
      const turn = d.turns?.[x.overall]
      const first = turn ? turn.advice.find((a) => tags.get(a.id) !== 'never')?.id : d.advised?.[x.overall]
      if (first && tags.get(first) !== 'never') advised[x.overall] = first
    }
    const asked = mineP.filter((x) => advised[x.overall])
    const departures = asked.filter((x) => advised[x.overall] !== x.playerId)
      .map((x) => ({ round: roundFor(x.overall, teams), took: p(x.playerId).name, advised: p(advised[x.overall]).name }))
    const s = prep.cats ? strengthOf(prep, mine) : null
    const win = s ? winChances(s, mine.length, prep.cats!.base) : null
    review = {
      expected: s ? expectedCats(s, mine.length, prep.cats!.base) : null,
      win,
      punting: win ? CATS.filter((c) => win[c] < 0.35) : [],
      value: prep.points ? mine.reduce((n, id) => n + (prep.points!.byId.get(id)?.value ?? 0), 0) : null,
      followed: asked.length - departures.length,
      advisedPicks: asked.length,
      departures,
      // As soon as my roster is full: a mock room often closes before Yahoo reports its last few picks.
      room: roomOf(prep, d, teams, slot!, rounds),
    }
  }

  // ── Who picks before my next turn ──
  const pickingBefore: DraftView['pickingBefore'] = []
  if (myNext != null && !onClock) {
    for (let o = overall; o < myNext && pickingBefore.length < 15; o++) {
      const seat = slotFor(o, teams)
      const manager = d.managers?.[seat - 1] ?? null
      const prof = manager ? opponents?.managers[personKey(manager)] : undefined
      pickingBefore.push({ overall: o, round: roundFor(o, teams), manager, habits: prof?.habits ?? [], seasons: prof?.seasons ?? 0 })
    }
  }
  const history = L.mock ? null : {
    seasons: opponents?.seasons.length ?? 0,
    consistent: opponents ? Object.entries(opponents.validation).filter(([, v]) => v.consistent).map(([k]) => k) : [],
  }

  const urgent = advice.filter((a) => !a.canWait)
  let takeNow = [...urgent, ...advice.filter((a) => a.canWait)].slice(0, 3)
  // The tiebreak orders the cards, never the players you are told can wait.
  if (takeNow.length) {
    const margin = prep.cats ? 0.02 : Math.abs(takeNow[0].score) * 0.01
    // No fit tiebreak: in 400 simulated Hoops drafts, breaking near-ties toward my weak
    // categories cost 0.46 points of all-play (±0.14), and toward my strong ones 0.62.
    // The advice's own score already weighs fit where it matters (scripts/nba-strategy-sim.ts).
    const tb = playoffTiebreak(takeNow, margin)
    takeNow = tb.advice
    playoffNote = tb.note
  }

  // Never the same player twice on the cards, whatever reordered them: the screen keys cards by player.
  takeNow = takeNow.filter((a, i) => takeNow.findIndex((x) => x.id === a.id) === i)
  // What each card would do to the build tiles: my roster with him added, as the tiles measure it.
  if (prep.cats) takeNow = takeNow.map((a) => ({ ...a, preview: winChances(strengthOf(prep, [...mine, a.id]), mine.length + 1, prep.cats!.base) }))
  const canWait = advice.filter((a) => a.canWait && !takeNow.some((t) => t.id === a.id)).slice(0, 3).map((a) => ({ name: a.name, survives: a.survives }))

  // ── What to queue in Yahoo, two picks out or on the clock ──
  let queue: DraftView['queue'] = null
  if (spot && myNext != null && myNext - overall <= 2) {
    // On the clock the cards are already unfiltered; off it, rank everyone as if the pick were now.
    const ranked = onClock ? advice
      : (prep.cats
        ? adviseCategories(prep.cats.rows.filter((r) => !taken.has(r.id)), mine.map((id) => prep.cats!.byId.get(id)!).filter(Boolean), spot, prep.cats.base,
          { canTake, neutralUntil: d.locks.length ? 0 : BUILD_FROM, ignore: d.locks })
        : advisePoints(prep.points!.rows.filter((r) => !taken.has(r.id)), spot, 25, canTake))
    // Ordered as the cards will be on the clock — those who will not last first, then the playoff
    // tiebreak — or a near-tie flips between now and then and the queue takes the wrong man.
    const order = onClock ? takeNow : (() => {
      const wait = (id: string) => nextAfter != null && (nextAfter === myNext + 1 || survives(prep.adp(id), nextAfter, prep.league.adpSpread, myNext) >= 0.6)
      const first3 = [...ranked.filter((a) => !wait(a.id)), ...ranked.filter((a) => wait(a.id))].slice(0, 3)
      const margin = prep.cats ? 0.02 : Math.abs(first3[0]?.score ?? 0) * 0.01
      return first3.length ? playoffTiebreak(first3.map((a) => ({ ...a, playoff: prep.playoff(a.id) })), margin).advice : []
    })()
    const top = order[0] ?? ranked[0]
    const ids = [...new Set([top?.id, top?.then, ...order.map((a) => a.id), ...ranked.map((a) => a.id)].filter(Boolean) as string[])].slice(0, 3)
    queue = ids.map((id) => ({ id, name: p(id).name }))
  }

  return {
    takeNow,
    canWait,
    queue,
    pickingBefore,
    history,
    review,
    mock: L.mock ?? null,
    playoffNote,
    weakSpots,
    strongSpots,
    liveRoom: d.picks.length ? liveRoom(prep, d, teams, slot) : null,
    playoffNorm: prep.playoffNorm,
    neverCount: [...tags.values()].filter((t) => t === 'never').length,
    league: { id: L.id, label: L.label, scoring: L.scoring, teams, rounds, slot, slotSource: d.slotSource, myTeamName: L.myTeamName },
    clock: { overall: done ? teams * rounds : overall, round: roundFor(Math.min(overall, teams * rounds), teams), onClock, myNext, picksUntil: myNext == null ? null : myNext - overall, done },
    sensor: d.sensor,
    roster: mineP.map((x) => ({ id: x.playerId, name: p(x.playerId).name, team: p(x.playerId).team, positions: prep.positions(x.playerId), overall: x.overall, round: roundFor(x.overall, teams) })),
    stillToFill: stillToFill(mine.map(prep.positions), prep.slots),
    build,
    advice,
    paths: paths.slice(0, prep.cats ? 12 : 1),
    ahead,
    aheadBuild: active?.name ?? '',
    board,
    log: [...d.picks].reverse().slice(0, 30).map((x) => ({
      overall: x.overall, round: roundFor(x.overall, teams), name: x.name, manager: x.manager ?? null,
      mine: slot != null && slotFor(x.overall, teams) === slot,
    })),
    feed: [...d.feed].reverse().slice(0, 20),
  }
}

/**
 * What changed since the last view that is worth a line in the feed. Only
 * things that change a decision: the build being read for the first time or
 * turning, a lock that has stopped paying, a target taken just before me.
 */
export interface CompareSide {
  id: string
  name: string
  team: string | null
  positions: string[]
  /** On the advice's own scale, as the cards are: categories a week (or value) with my next turn counted in. */
  score: number
  /** Chance he is back at my next turn if I pass. */
  survives: number
  /** Win chance per category with him added (categories leagues). */
  preview: Strength | null
  /** Categories he leaves stronger than the other does, by two points or more. */
  better: Cat[]
  fpg: number | null
  gp: number
  /** His place on the cards (1-3), or null. */
  card: number | null
  /** Whether I could take him now: not on the never list, the roster can still fill. */
  takeable: boolean
  /** Players I already have from his NBA team. */
  mates: string[]
}

export interface CompareView {
  unit: 'categories' | 'value'
  /** My win chances now, for the tiles' starting point. */
  now: Strength | null
  sides: CompareSide[]
  /** The answer in a sentence. */
  verdict: string
  nextPick: number | null
}

/**
 * Two players side by side on the advice's own scale — a card against a card,
 * or a player I am tempted by against the top card. The score is the same one
 * the cards are ranked by, so it counts who would still be there next turn;
 * the categories say where each one would take the build.
 */
export function compareView(prep: Prepared, d: StoredDraft, tags: Map<string, PrefTag>, ids: string[], cards: string[]): CompareView | null {
  const L = prep.league
  const teams = teamsIn(d, L.teams)
  const rounds = prep.rounds
  const taken = new Set(d.picks.map((p) => p.playerId))
  const overall = (d.picks.at(-1)?.overall ?? 0) + 1
  const slot = d.slot
  if (slot == null || overall > teams * rounds) return null
  const mine = myPicks(d, teams, slotFor).map((p) => p.playerId)
  const myNext = nextPickFor(slot, teams, rounds, overall - 1)
  if (myNext == null) return null
  const nextAfter = nextPickFor(slot, teams, rounds, myNext)
  const spot = { teams, rounds, slot, overall: myNext, spread: L.adpSpread }
  const canTake = canTakeFor(prep, mine, tags)
  const want = ids.filter((id) => !taken.has(id) && prep.players.has(id)).slice(0, 2)
  if (!want.length) return null
  const scored = prep.cats
    ? adviseCategories(prep.cats.rows.filter((r) => !taken.has(r.id)), mine.map((id) => prep.cats!.byId.get(id)!).filter(Boolean), spot, prep.cats.base,
      { canTake, neutralUntil: d.locks.length ? 0 : BUILD_FROM, ignore: d.locks, include: want })
    : advisePoints(prep.points!.rows.filter((r) => !taken.has(r.id)), spot, 25, canTake, want)
  const back = (id: string) => nextAfter == null ? 0 : nextAfter === myNext + 1 ? 1 : survives(prep.adp(id), nextAfter, L.adpSpread, myNext)
  const sides: CompareSide[] = want.map((id) => {
    const a = scored.find((x) => x.id === id)
    const p = prep.players.get(id)!
    return {
      id, name: p.name, team: p.team, positions: prep.positions(id),
      score: a?.score ?? -Infinity, survives: back(id),
      preview: prep.cats ? winChances(strengthOf(prep, [...mine, id]), mine.length + 1, prep.cats.base) : null,
      better: [], fpg: prep.points?.byId.get(id)?.fpg ?? null, gp: gamesOf(prep, id),
      card: cards.includes(id) ? cards.indexOf(id) + 1 : null, takeable: canTake(id),
      mates: p.team ? mine.filter((m) => prep.players.get(m)!.team === p.team).map((m) => prep.players.get(m)!.name) : [],
    }
  })
  if (sides.length === 2 && sides[0].preview && sides[1].preview) {
    const [x, y] = sides
    x.better = CATS.filter((c) => !d.locks.includes(c) && x.preview![c] - y.preview![c] >= 0.02)
    y.better = CATS.filter((c) => !d.locks.includes(c) && y.preview![c] - x.preview![c] >= 0.02)
  }
  const words = (cs: Cat[]) => {
    const l = cs.map((c) => (c === 'to' ? 'fewer turnovers' : CAT_LABEL[c]))
    return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0] ?? ''
  }
  const last = (n: string) => n.split(' ').at(-1)
  const weeks = ((L as NbaLeague & { playoffWeeks?: number[] }).playoffWeeks?.[0] ?? 20) - 1
  let verdict = ''
  if (sides.length === 2) {
    const [a, b] = [...sides].sort((p, q) => q.score - p.score)
    const gap = a.score - b.score
    const cats = !!prep.cats
    const close = cats ? gap < 0.02 : gap < Math.abs(a.score) * 0.01
    // In words: a gap in categories a week, over the regular season, is categories won; a points gap is points above replacement.
    const amount = cats
      ? `${gap.toFixed(2)} categories a week — about ${Math.max(1, Math.round(gap * weeks))} more categor${Math.round(gap * weeks) > 1 ? 'ies' : 'y'} won over the season`
      : `about ${Math.round(gap)} fantasy points over the season`
    const leans = cats
      ? (a.better.length || b.better.length ? ` ${last(a.name)} gives you more ${a.better.length ? words(a.better) : 'of nothing in particular'}; ${last(b.name)} more ${b.better.length ? words(b.better) : 'of nothing in particular'}.` : '')
      // Points: what a game is worth against how many games, which is all the value is.
      : a.fpg != null && b.fpg != null
        ? a.fpg < b.fpg && a.gp - b.gp >= 3 ? ` ${last(b.name)} scores more a game (${b.fpg.toFixed(1)} to ${a.fpg.toFixed(1)}), but ${last(a.name)} is projected for ${Math.round(a.gp - b.gp)} more games.`
          : a.fpg > b.fpg ? ` ${last(a.name)} scores more a game (${a.fpg.toFixed(1)} to ${b.fpg.toFixed(1)}).` : ''
        : ''
    if (!b.takeable) verdict = `${b.name} cannot fill a seat your roster still needs — ${a.name}.`
    else if (!Number.isFinite(b.score)) verdict = `${a.name}: ${b.name} is too far down the list to score against him.`
    else if (close) verdict = cats
      ? `A coin flip: ${a.name} by only ${gap.toFixed(2)} categories a week, inside the noise. Take the one whose categories you want.${leans}`
      : `A coin flip: ${a.name} by ${amount}, inside the noise. Take whom you prefer.`
    else {
      const wait = nextAfter == null ? ''
        : b.survives >= 0.6 ? ` And ${b.name} is ${Math.round(b.survives * 100)}% likely back at pick ${nextAfter}, so you may get both.`
        : b.survives >= 0.3 ? ` ${b.name} has a ${Math.round(b.survives * 100)}% chance of lasting to pick ${nextAfter}.` : ''
      verdict = `${a.name} by ${amount}.${leans}${wait}`
    }
  } else verdict = `${sides[0].name}: pin a second player to compare.`
  return {
    unit: prep.cats ? 'categories' : 'value',
    now: prep.cats && mine.length ? winChances(strengthOf(prep, mine), mine.length, prep.cats.base) : null,
    sides, verdict, nextPick: nextAfter,
  }
}

export function changes(prev: DraftView | null, next: DraftView, now = Date.now()): FeedItem[] {
  if (!prev) return []
  const out: FeedItem[] = []
  const label = (cs: Cat[]) => cs.map((c) => CAT_LABEL[c]).join(', ')
  const pb = prev.build, nb = next.build
  if (pb && nb) {
    if (pb.stage === 'open' && nb.stage !== 'open') {
      out.push({ at: now, kind: 'build', text: nb.punting.length ? `Build read: you are punting ${label(nb.punting)}` : `Build read: nothing given up yet; weakest are ${label(CATS.filter((c) => nb.win && nb.win[c] < 0.5).slice(0, 2))}` })
    } else if (pb.stage !== 'open' && nb.stage !== 'open' && label(pb.punting) !== label(nb.punting)) {
      out.push({ at: now, kind: 'build', text: nb.punting.length ? `Build turned: now punting ${label(nb.punting)}` : `Build turned: no longer punting ${label(pb.punting)}` })
    }
    if (pb.stage === 'leaning' && nb.stage === 'firm') out.push({ at: now, kind: 'build', text: `Build is firm from here${nb.punting.length ? `: punt ${label(nb.punting)}` : ''}` })
    for (const c of nb.locks) {
      if (nb.win && nb.win[c] >= 0.55 && !(pb.win && pb.win[c] >= 0.55)) out.push({ at: now, kind: 'lock', text: `You locked ${CAT_LABEL[c]} as a punt, but you are winning it ${(nb.win[c] * 100).toFixed(0)}% of weeks` })
    }
  }
  const lockedPrev = prev.paths.find((x) => x.locked), lockedNext = next.paths.find((x) => x.locked), best = next.paths[0]
  if (lockedNext && best && !best.locked && best.expected - lockedNext.expected >= 0.3 && !(lockedPrev && prev.paths[0] && prev.paths[0].expected - lockedPrev.expected >= 0.3)) {
    out.push({ at: now, kind: 'lock', text: `${best.name} now projects ${(best.expected - lockedNext.expected).toFixed(1)} more categories a week than your locked ${lockedNext.name}` })
  }
  const nextTargets = new Set(prev.ahead[0]?.players.map((x) => x.id) ?? [])
  const prevTaken = new Set(prev.board.filter((r) => r.takenAt != null).map((r) => r.id))
  for (const r of next.board) {
    // Only a loss if he went before the pick he was the target for.
    if (r.takenAt != null && !prevTaken.has(r.id) && !r.mine && nextTargets.has(r.id) && r.takenAt < (prev.ahead[0]?.overall ?? 0)) out.push({ at: now, kind: 'target', text: `${r.name}, a target for pick ${prev.ahead[0]?.overall}, went at ${r.takenAt}${r.takenBy ? ` to ${r.takenBy}` : ''}` })
  }
  // Runs: four of the last six picks at one position group.
  const recent = next.board.filter((r) => r.takenAt != null && r.takenAt > next.clock.overall - 7).map((r) => r.positions)
  const isBig = (ps: string[]) => ps.includes('C') && !ps.some((x) => x === 'PG' || x === 'SG')
  const isGuard = (ps: string[]) => ps.includes('PG') && !ps.includes('C')
  for (const [kind, test] of [['centres', isBig], ['point guards', isGuard]] as const) {
    const n = recent.filter(test).length
    const before = prev.board.filter((r) => r.takenAt != null && r.takenAt > prev.clock.overall - 7).map((r) => r.positions).filter(test).length
    if (n >= 4 && before < 4) out.push({ at: now, kind: 'run', text: `Run on ${kind}: ${n} of the last six picks` })
  }
  return out
}

export { overallFor }

/**
 * A finished draft as one record for comparing mocks. The cost of a pick is
 * the advice's first choice less the pick made, in the advice's own score, at
 * the turn it was made; a pick from outside the list the screen kept is costed
 * at the list's last entry, which understates it.
 */
export function recordOf(prep: Prepared, d: StoredDraft, tags: Map<string, PrefTag>): MockRecord | null {
  const view = buildView(prep, d, tags)
  if (!view.review) return null
  const teams = view.league.teams
  const mine = d.slot == null ? [] : myPicks(d, teams, slotFor)
  const name = (id: string) => prep.players.get(id)?.name ?? id
  const picks = mine.map((x) => {
    const raw = d.turns?.[x.overall]
    // Never-list players are struck from what the advice offered, as in the review.
    const turn = raw ? { ...raw, advice: raw.advice.filter((a) => tags.get(a.id) !== 'never') } : undefined
    const top = turn?.advice[0]
    const took = turn?.advice.find((a) => a.id === x.playerId)
    const cost = !top ? null : took ? top.score - took.score : top.score - turn!.advice[turn!.advice.length - 1].score
    return {
      overall: x.overall, round: roundFor(x.overall, teams),
      took: name(x.playerId), tookPositions: prep.positions(x.playerId),
      advised: top ? name(top.id) : null, advisedPositions: top ? prep.positions(top.id) : [],
      cost,
      waitedWrong: !!(top && took && took.id !== top.id && took.canWait && !top.canWait),
      stage: turn?.stage ?? null,
    }
  })
  const firstLocked = mine.find((x) => (d.turns?.[x.overall]?.locks.length ?? 0) > 0)
  return {
    id: d.leagueId,
    when: d.feed[0]?.at ?? d.turns?.[mine[0]?.overall ?? 0]?.at ?? 0,
    seat: d.slot,
    result: view.review.expected ?? view.review.value ?? 0,
    fpSeason: prep.points ? mine.reduce((n, x) => n + (prep.points!.byId.get(x.playerId)?.season ?? 0), 0) : null,
    place: placeOf(prep, d, teams, prep.rounds),
    punting: view.review.punting,
    win: view.review.win,
    locks: d.locks,
    lockedFromRound: firstLocked ? roundFor(firstLocked.overall, teams) : null,
    picks,
  }
}

/**
 * The playoff schedule as a tiebreaker, and only that. Among the options that
 * score within `margin` of the first choice — a gap the projections cannot
 * honestly separate — the one whose team plays more games in this league's
 * playoff weeks goes first. A clear gap is never overruled: the schedule is
 * three weeks of twenty.
 */
/** A category counts as covered when a player adds at least this much of it over a season (in z, games-weighted). */
export const FIT_MIN = 0.25
/** The band in which a category is still in play: a pick moves its weekly win chance most here. */
export const CLOSE_LOW = 0.35
export const CLOSE_HIGH = 0.65


export function playoffTiebreak<T extends { name: string; score: number; playoff: number | null; tiebreak?: boolean }>(advice: T[], margin: number): { advice: T[]; note: string | null } {
  if (advice.length < 2) return { advice, note: null }
  const top = advice[0].score
  const close = advice.filter((a) => top - a.score <= margin)
  if (close.length < 2) return { advice, note: null }
  const known = close.filter((a) => a.playoff != null)
  const most = Math.max(...known.map((a) => a.playoff!))
  const least = Math.min(...known.map((a) => a.playoff!))
  if (known.length < 2 || most === least) return { advice, note: null }
  const reordered = [...close].sort((a, b) => (b.playoff ?? -1) - (a.playoff ?? -1) || b.score - a.score)
  const moved = reordered[0] !== advice[0]
  // The rest in their own order. Not advice.slice(close.length): the cards are not sorted by score
  // (players who will be gone come first), so the close ones need not be the first few — slicing
  // repeated one card and dropped another.
  const out = [...reordered.map((a, i) => (i === 0 && moved ? { ...a, tiebreak: true } : a)), ...advice.filter((a) => !close.includes(a))]
  const lead = reordered[0], other = reordered.find((a) => a.playoff === least)!
  return {
    advice: out,
    note: `${close.map((a) => a.name).join(', ')} are too close to call; ${lead.name} plays ${lead.playoff} games in your playoff weeks, ${other.name} ${other.playoff}${moved ? ' — so he goes first' : ''}.`,
  }
}
