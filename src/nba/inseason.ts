/**
 * One basketball league's season, as a screen: today's lineup, the week's
 * matchup, adds, news. Pure: the server reads Yahoo, Sleeper and CBS and hands
 * the answers in; this works out what they mean.
 *
 * Football's cockpit answers "which league needs me"; basketball asks it every
 * day, because lineups are daily. So the first thing this says is whether
 * tonight's lineup is right, and the second is where the week can still be won.
 */
import type { YPlayer, YStanding, YTransaction } from '../server/yahooParse.js'
import type { NbaPlayer, Game, YahooWeek } from './types.js'
import type { InjuryNote } from './sources.js'
import { NameIndex } from './join.js'
import { CATS, categoryZ, type Cat } from './value.js'
import { emptyBox, type Box, type NbaMatchup, type RosterDay, type SeasonSettings, type Side, type TeamMeta } from './yahooSeason.js'
import { daysFrom, projectWeek, seat, startingSeats, type GameOutlook, type Man, type WeekOutlook } from './week.js'
import { categoryWeek, pointsWeek, type PointsOdds, type SideOutlook, type WeekOdds, type Weights } from './matchup.js'
import { designation, perGameBox, playChance, withForm, type Designation, type GameLog } from './outlook.js'
import { typicalWeek, type Member, type Noise } from './strength.js'

export interface SeasonLeague {
  id: string
  label: string
  leagueKey: string
  scoring: 'points' | 'categories'
  points?: Weights
  teams: number
  roster: Record<string, number>
  adds: { perWeek: number | null; season: number | null }
  playoffWeeks: number[]
}

/** What the server has read from Yahoo for one league. */
export interface Snapshot {
  at: number
  settings: SeasonSettings | null
  weeks: YahooWeek[]
  /** Every team's roster as Yahoo last reported it. */
  rosters: { team: TeamMeta; players: YPlayer[] }[]
  /** My roster today, with today's seats. */
  mineToday: RosterDay | null
  /** The current week's scoreboard, every matchup. */
  scoreboard: NbaMatchup[]
  /** Finished weeks' scoreboards, for all-play. */
  past: Record<number, NbaMatchup[]>
  standings: YStanding[]
  /** Yahoo ids of players on waivers, who cannot be added straight away. */
  waivers: string[]
  transactions: YTransaction[]
}

/** What the server knows about players and the calendar, shared by every league. */
export interface World {
  players: NbaPlayer[]
  /** Season-to-date game logs. */
  logs: GameLog[]
  /** Sleeper's per-game projections for dates this week, keyed `id|date`. */
  dayProj: Map<string, { box: Box; min: number }>
  injuries: InjuryNote[]
  /** Return dates set by hand, by player id. */
  returns: Map<string, string>
  schedule: Game[]
  noise: Noise
  /** Never-list ids: never offered as a pickup or a trade target. */
  never: Set<string>
  now: number
  /** Today's date in US Eastern, the league's calendar. */
  today: string
}

const YAHOO_TEAM: Record<string, string> = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', PHO: 'PHX', UTAH: 'UTA', WSH: 'WAS', BKLYN: 'BKN', BRK: 'BKN', CHO: 'CHA' }
export const teamCode = (t: string | null) => (t ? YAHOO_TEAM[t.toUpperCase()] ?? t.toUpperCase() : null)

const POS = new Set(['PG', 'SG', 'SF', 'PF', 'C'])
/** Positions that matter for seating, from Yahoo's eligible list (G and F expanded). */
export function seatPositions(eligible: string[]): string[] {
  const out = new Set<string>()
  for (const e of eligible) {
    if (POS.has(e)) out.add(e)
    if (e === 'G') { out.add('PG'); out.add('SG') }
    if (e === 'F') { out.add('SF'); out.add('PF') }
  }
  return [...out]
}

const RESERVE = new Set(['BN', 'IL', 'IL+', 'IR', 'NA'])
export const isStarting = (slot: string | null) => !!slot && !RESERVE.has(slot)

/**
 * Everything about players that every part of the screen needs: who a Yahoo
 * player is, his form, whether he plays, what a game of his is worth.
 */
export class Context {
  readonly byId = new Map<string, NbaPlayer & { formGames: number; recentMin: number | null; seasonMin: number | null }>()
  private readonly index: NameIndex
  private readonly byYahoo = new Map<string, string>()
  private readonly cbs = new Map<string, InjuryNote>()
  private readonly status = new Map<string, Designation>()
  private readonly z = new Map<string, Record<Cat, number>>()
  readonly teamDates = new Map<string, string[]>()

  constructor(readonly league: SeasonLeague, readonly world: World, yahooStatus: Map<string, string | null> = new Map()) {
    const logs = new Map<string, GameLog[]>()
    for (const l of world.logs) (logs.get(l.id) ?? logs.set(l.id, []).get(l.id)!).push(l)
    for (const p of world.players) this.byId.set(p.id, withForm(p, logs.get(p.id) ?? []))
    this.index = new NameIndex(world.players.map((p) => ({ id: p.id, name: p.name, team: p.team })))
    for (const p of world.players) if (p.yahoo?.yahooId) this.byYahoo.set(p.yahoo.yahooId, p.id)
    for (const i of world.injuries) {
      const id = this.index.resolve(i.name, null)
      if (id) this.cbs.set(id, i)
    }
    for (const p of world.players) {
      this.status.set(p.id, designation(yahooStatus.get(p.id), p.injury?.status))
    }
    for (const g of world.schedule) {
      for (const t of [g.home, g.away]) (this.teamDates.get(t) ?? this.teamDates.set(t, []).get(t)!).push(g.date)
    }
    if (league.scoring === 'categories') {
      for (const r of categoryZ([...this.byId.values()], { teams: league.teams, roster: league.roster })) this.z.set(r.id, r.z)
    }
  }

  resolve(y: YPlayer): string | null {
    return this.byYahoo.get(y.yahooId) ?? this.index.resolve(y.name, teamCode(y.team))
  }

  /** A Yahoo status for a player overrides what the player file was built with. */
  setStatus(id: string, yahooStatus: string | null) {
    const p = this.byId.get(id)
    this.status.set(id, designation(yahooStatus, p?.injury?.status))
  }

  designation(id: string): Designation { return this.status.get(id) ?? 'healthy' }

  returnOf(id: string): { date: string | null; outForSeason: boolean; text: string | null } {
    const mine = this.world.returns.get(id)
    const c = this.cbs.get(id)
    return { date: mine ?? c?.returnDate ?? null, outForSeason: !mine && !!c?.outForSeason, text: c?.text ?? null }
  }

  play(id: string, date: string): number {
    const r = this.returnOf(id)
    return playChance(this.designation(id), date, this.world.today, r.date, r.outForSeason)
  }

  outlook(id: string, date: string): GameOutlook | null {
    const p = this.byId.get(id)
    if (!p) return null
    const sleeper = this.world.dayProj.get(`${id}|${date}`)
    return { box: sleeper?.box ?? perGameBox(p), play: this.play(id, date) }
  }

  perGame(id: string): Box {
    const p = this.byId.get(id)
    return p ? perGameBox(p) : emptyBox()
  }

  /** One number per game: summed z over the categories in play, or fantasy points. */
  worth(id: string, punts: Cat[] = []): number {
    if (this.league.scoring === 'points') return fpOf(this.perGame(id), this.league.points ?? {})
    const z = this.z.get(id)
    if (!z) return -5
    return CATS.filter((c) => !punts.includes(c)).reduce((s, c) => s + z[c], 0)
  }

  /** Team games left in the season from today (inclusive). */
  teamGamesLeft(team: string | null, from = this.world.today): number {
    return (this.teamDates.get(team ?? '') ?? []).filter((d) => d >= from).length
  }

  /** Games he is expected to play for the rest of the season. */
  gamesLeft(id: string): number {
    const p = this.byId.get(id)
    if (!p) return 0
    const r = this.returnOf(id)
    if (r.outForSeason) return 0
    const from = r.date && r.date > this.world.today ? r.date : this.world.today
    const rate = Math.min(0.95, Math.max(0.6, p.durability.gpShare ?? 0.85))
    return this.teamGamesLeft(p.team, from) * rate
  }

  man(id: string, eligible: string[] | null = null): Man {
    const p = this.byId.get(id)
    return { id, name: p?.name ?? id, positions: seatPositions(eligible ?? p?.positions ?? []), team: p?.team ?? null }
  }
}

const fpOf = (b: Box, w: Weights) =>
  (w.pts ?? 0) * b.pts + (w.reb ?? 0) * b.reb + (w.ast ?? 0) * b.ast + (w.stl ?? 0) * b.stl + (w.blk ?? 0) * b.blk + (w.to ?? 0) * b.to + (w.tpm ?? 0) * b.tpm

/** The fantasy week containing a date. */
export function weekOf(weeks: YahooWeek[], date: string): YahooWeek | null {
  return weeks.find(([, s, e]) => s <= date && date <= e) ?? null
}

/** Teams with a game still to tip on a date: today, only games not yet started. */
export function playingOn(schedule: Game[], date: string, today: string, now: number): Set<string> {
  const out = new Set<string>()
  for (const g of schedule) {
    if (g.date !== date) continue
    if (date === today && g.tip && Date.parse(g.tip) <= now) continue
    out.add(g.home); out.add(g.away)
  }
  return out
}

/** Today's game for a team: opponent and tip, where there is one. */
export function gameToday(schedule: Game[], team: string | null, date: string): { vs: string; home: boolean; tip: string | null } | null {
  const g = schedule.find((x) => x.date === date && (x.home === team || x.away === team))
  return g ? { vs: g.home === team ? g.away : g.home, home: g.home === team, tip: g.tip ?? null } : null
}

// ── Today's lineup ──────────────────────────────────────────────────────────

export interface LineupRow {
  id: string
  name: string
  slot: string | null
  positions: string[]
  game: { vs: string; home: boolean; tip: string | null; started: boolean } | null
  status: Designation
  play: number
}

export interface LineupMove {
  start: string
  /** The player to take out of the seat, where one has to be. */
  bench: string | null
  why: string
  /** When the move stops being possible: the tip of the game it is about. */
  by: string | null
}

export interface LineupCheck {
  date: string
  rows: LineupRow[]
  moves: LineupMove[]
  /** Starts that would be lost tonight as the lineup stands. */
  lostStarts: number
  ok: boolean
}

/**
 * Whether today's lineup as set seats the best players who can still play.
 * Players whose games have tipped are locked where they are. Of the rest, the
 * best possible lineup is found and compared with the one set.
 */
export function checkLineup(ctx: Context, day: RosterDay, seats: string[]): LineupCheck {
  const { today, now, schedule } = ctx.world
  const rows: LineupRow[] = []
  for (const y of day.players) {
    const id = ctx.resolve(y)
    if (!id) continue
    ctx.setStatus(id, y.status)
    const p = ctx.byId.get(id)!
    const g = gameToday(schedule, p.team, today)
    const started = !!g?.tip && Date.parse(g.tip) <= now
    rows.push({
      id, name: p.name, slot: y.slot, positions: seatPositions(y.eligible), status: ctx.designation(id),
      game: g ? { ...g, started } : null, play: g ? ctx.play(id, today) : 0,
    })
  }
  // Seats already spoken for by players whose game has started.
  const lockedIn = rows.filter((r) => r.game?.started && isStarting(r.slot))
  const free = [...seats]
  for (const r of lockedIn) {
    const i = free.findIndex((s) => s === r.slot) >= 0 ? free.findIndex((s) => s === r.slot) : free.indexOf('Util')
    if (i >= 0) free.splice(i, 1)
  }
  const movable = rows.filter((r) => r.slot !== 'IL' && r.slot !== 'IL+' && !r.game?.started)
  const able = movable.filter((r) => r.game && r.play > 0)
  const worth = able.map((r) => ctx.worth(r.id) * r.play + 100 * r.play)
  const best = new Set([...seat(able.map((r) => r.positions), worth, free).values()].map((i) => able[i].id))
  const startingNow = new Set(movable.filter((r) => isStarting(r.slot)).map((r) => r.id))

  const moves: LineupMove[] = []
  const toStart = able.filter((r) => best.has(r.id) && !startingNow.has(r.id))
    .sort((a, b) => ctx.worth(b.id) - ctx.worth(a.id))
  // Who comes out: starters who will not play first, then the weakest of the rest.
  const willPlay = (r: LineupRow) => !!r.game && r.play > 0
  const outs = movable.filter((r) => startingNow.has(r.id) && !best.has(r.id))
    .sort((a, b) => Number(willPlay(a)) - Number(willPlay(b)) || ctx.worth(a.id) - ctx.worth(b.id))
  let lostStarts = 0
  toStart.forEach((r, i) => {
    const out = outs[i] ?? null
    if (!out || !willPlay(out)) lostStarts++
    const why = !out ? 'a seat is open'
      : !out.game ? `${out.name} has no game today`
      : out.play === 0 ? `${out.name} is ${out.status}`
      : `${r.name} is the better start today`
    moves.push({ start: r.id, bench: out?.id ?? null, why, by: r.game?.tip ?? null })
  })
  // The move that locks first comes first.
  moves.sort((a, b) => (a.by ?? '9').localeCompare(b.by ?? '9'))
  return { date: today, rows, moves, lostStarts, ok: moves.length === 0 }
}

// ── The week ────────────────────────────────────────────────────────────────

export interface WeekView {
  week: number
  start: string
  end: string
  opponent: { id: string; name: string; manager: string } | null
  /** Categories won so far (Yahoo's count) or fantasy points so far. */
  score: { mine: number | null; theirs: number | null }
  odds: WeekOdds | null
  points: PointsOdds | null
  /** Expected starts left, each side, and my player-games with no seat. */
  startsLeft: { mine: number; theirs: number }
  idleGames: number
  days: { date: string; mine: number; theirs: number; idle: number }[]
  playoffs: boolean
}

export function sideOutlook(ctx: Context, side: Side | null, ids: { id: string; eligible: string[] }[], seats: string[], days: string[]): { side: SideOutlook; week: WeekOutlook } {
  const { schedule, today, now } = ctx.world
  const week = projectWeek({
    men: ids.map((x) => ctx.man(x.id, x.eligible)),
    seats, days,
    playing: (d) => playingOn(schedule, d, today, now),
    outlook: (id, d) => ctx.outlook(id, d),
    worth: (id) => ctx.worth(id) + 100,
  })
  return { side: { now: side?.box ?? emptyBox(), rest: week.box, restVar: week.variance }, week }
}

export function rosterIds(ctx: Context, players: YPlayer[]): { id: string; eligible: string[] }[] {
  const out: { id: string; eligible: string[] }[] = []
  for (const y of players) {
    if (y.slot === 'IL' || y.slot === 'IL+') continue
    const id = ctx.resolve(y)
    if (!id) continue
    ctx.setStatus(id, y.status)
    out.push({ id, eligible: y.eligible })
  }
  return out
}

export function buildWeek(ctx: Context, snap: Snapshot, myTeamId: string): WeekView | null {
  const { today } = ctx.world
  const wk = weekOf(snap.weeks, today)
  const m = snap.scoreboard.find((x) => x.sides.some((s) => s.id === myTeamId))
  if (!wk && !m) return null
  const start = m?.start ?? wk![1], end = m?.end ?? wk![2]
  const mine = m?.sides.find((s) => s.id === myTeamId) ?? null
  const theirs = m?.sides.find((s) => s.id !== myTeamId) ?? null
  const seats = startingSeats(ctx.league.roster)
  const days = daysFrom(start, end, today)
  const rosterOf = (teamId: string | undefined) => snap.rosters.find((r) => r.team.id === teamId)?.players ?? []
  const a = sideOutlook(ctx, mine, rosterIds(ctx, rosterOf(myTeamId)), seats, days)
  const b = sideOutlook(ctx, theirs, rosterIds(ctx, rosterOf(theirs?.id)), seats, days)
  const odds = ctx.league.scoring === 'categories' ? categoryWeek(a.side, b.side) : null
  const points = ctx.league.scoring === 'points'
    ? pointsWeek(a.side, b.side, ctx.league.points ?? {}, { mine: mine?.points ?? null, theirs: theirs?.points ?? null })
    : null
  return {
    week: m?.week ?? wk![0], start, end,
    opponent: theirs ? { id: theirs.id, name: theirs.name, manager: theirs.manager } : null,
    score: { mine: mine?.points ?? null, theirs: theirs?.points ?? null },
    odds, points,
    startsLeft: { mine: a.week.starts, theirs: b.week.starts },
    idleGames: a.week.wasted,
    days: days.map((d, i) => ({
      date: d,
      mine: a.week.days[i]?.starting.length ?? 0,
      theirs: b.week.days[i]?.starting.length ?? 0,
      idle: a.week.days[i]?.idle.length ?? 0,
    })),
    playoffs: !!m?.playoffs,
  }
}

/** Every team's typical week from its roster, for season-long questions. */
export function teamWeeks(ctx: Context, snap: Snapshot): Map<string, { box: ReturnType<typeof typicalWeek>; members: Member[] }> {
  const seats = startingSeats(ctx.league.roster).length
  const out = new Map<string, { box: ReturnType<typeof typicalWeek>; members: Member[] }>()
  for (const r of snap.rosters) {
    const members = rosterIds(ctx, r.players).map(({ id }) => member(ctx, id))
    out.set(r.team.id, { box: typicalWeek(members, seats), members })
  }
  return out
}

export function member(ctx: Context, id: string): Member {
  const left = ctx.teamGamesLeft(ctx.byId.get(id)?.team ?? null)
  return { id, box: ctx.perGame(id), avail: left ? ctx.gamesLeft(id) / left : 0, worth: ctx.worth(id) }
}
