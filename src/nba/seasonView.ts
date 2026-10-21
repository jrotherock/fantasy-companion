/**
 * The whole basketball league screen, and the one-line tile the home screen
 * shows for it. Assembled from the parts in inseason.ts, adds.ts, news.ts and
 * extras.ts; nothing here reads the network.
 */
import type { Weights } from './matchup.js'
import type { Cat } from './value.js'
import { CATS } from './value.js'
import { startingSeats } from './week.js'
import { buildWeek, checkLineup, Context, type LineupCheck, type SeasonLeague, type Snapshot, type WeekView, type World } from './inseason.js'
import { addDays, addPlan, budgetOf, categoryPlan, pickupsAndPairs, type AddPlan, type Budget, type CategoryPlan, type PairMove, type Pickup } from './adds.js'
import { leagueNews, type NewsItem, type StatusEvent } from './news.js'
import { allPlay, playoffPlan, power, tradeIdeas, type AllPlay, type PlayoffPlan, type PowerRow, type TradeIdea } from './extras.js'
import type { Alert } from '../server/alerts.js'

export interface PlayerRef { name: string; team: string | null; positions: string[] }

export interface SeasonView {
  league: { id: string; label: string; scoring: 'points' | 'categories'; teams: number; /** A points league's weights, for the fantasy points on its screens. */ points: Weights | null }
  at: number
  today: string
  phase: 'before-draft' | 'season'
  myTeam: { id: string; name: string } | null
  lineup: LineupCheck | null
  /** Tomorrow's lineup as set, checked against tomorrow's games: the starts it would lose, a day ahead. */
  tomorrow: LineupCheck | null
  week: WeekView | null
  budget: Budget | null
  pickups: Pickup[]
  /** Two moves together that beat any one move by a second move's worth. */
  pairs: PairMove[]
  news: NewsItem[]
  /** Categories my roster is not competing in, read from how it compares with the league. */
  punts: Cat[]
  power: PowerRow[]
  allPlay: AllPlay | null
  playoffs: PlayoffPlan | null
  trades: TradeIdea[]
  standing: { rank: number | null; w: number | null; l: number | null; t: number | null } | null
  players: Record<string, PlayerRef>
  /** Before week 1: the day the season starts. Streams and lineups have nothing to say until then. */
  startsOn: string | null
  /** The week's adds as a plan, and the season's category plan (categories leagues). */
  addPlan: AddPlan | null
  catPlan: CategoryPlan | null
}

/** A category my team beats an average opponent in less than this often is one it has given up. */
export const PUNT_EDGE = 0.25

export function myTeamOf(snap: Snapshot, configured?: string | null): { id: string; name: string } | null {
  const t = snap.rosters.find((r) => r.team.mine)?.team
    ?? snap.scoreboard.flatMap((m) => m.sides).find((s) => s.mine)
    ?? (configured ? snap.rosters.find((r) => r.team.id === configured)?.team : null)
  return t ? { id: t.id, name: t.name } : configured ? { id: configured, name: '' } : null
}

export function buildSeasonView(league: SeasonLeague & { myTeamId?: string | null }, snap: Snapshot, world: World, events: StatusEvent[] = []): SeasonView {
  const yahooStatus = new Map<string, string | null>()
  const ctx = new Context(league, world, yahooStatus)
  const me = myTeamOf(snap, league.myTeamId)
  const drafted = snap.rosters.some((r) => r.players.length > 0)
  const base: SeasonView = {
    league: { id: league.id, label: league.label, scoring: league.scoring, teams: league.teams, points: league.scoring === 'points' ? league.points ?? null : null },
    at: snap.at, today: world.today, phase: drafted ? 'season' : 'before-draft', myTeam: me,
    lineup: null, tomorrow: null, week: null, budget: null, pickups: [], pairs: [], news: [], punts: [], power: [], allPlay: null, playoffs: null, trades: [],
    standing: null, players: {}, startsOn: null, addPlan: null, catPlan: null,
  }
  if (!drafted || !me) return base

  // Yahoo's designations for every rostered player, before anything asks whether he plays.
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) ctx.setStatus(id, y.status) }

  const pw = power(ctx, snap)
  const mine = pw.find((r) => r.teamId === me.id)
  const punts = league.scoring === 'categories' && mine?.edges
    ? CATS.filter((c) => (mine.edges![c] ?? 0.5) < PUNT_EDGE)
    : []
  const lineup = snap.mineToday ? checkLineup(ctx, snap.mineToday, startingSeats(league.roster)) : null
  // Tomorrow's lineup as set: a starter with no game tomorrow while a bench player has one is a start lost unless
  // changed (2026-10-20: Harden, Murray and Allen started a Wednesday their teams did not play).
  const tomorrowDate = addDays(world.today, 1)
  const tomorrow = snap.mineTomorrow?.date === tomorrowDate ? checkLineup(ctx, snap.mineTomorrow, startingSeats(league.roster), tomorrowDate) : null
  const week = buildWeek(ctx, snap, me.id)
  // Games left in the matchup week for each player on today's lineup: what decides who starts and who streams.
  if (lineup && week) {
    const from = world.today > week.start ? world.today : week.start
    for (const r of lineup.rows) {
      const team = ctx.byId.get(r.id)?.team
      r.weekGames = team ? world.schedule.filter((g) => g.date >= from && g.date <= week.end && (g.home === team || g.away === team)).length : null
    }
  }
  const budget = budgetOf(snap, me.id, league, world.today)
  const { pickups: picks, pairs } = pickupsAndPairs(ctx, snap, me.id, { punts })
  const news = leagueNews(ctx, snap, me.id, events, week?.opponent?.id ?? null).slice(0, 40)
  const st = snap.standings.find((s) => s.teamId === me.id || s.mine)

  const view: SeasonView = {
    ...base, lineup, tomorrow, week, budget, pickups: picks, pairs, news, punts, power: pw,
    allPlay: allPlay(snap.past, me.id, league.scoring),
    playoffs: playoffPlan(ctx, snap, me.id),
    trades: tradeIdeas(ctx, snap, me.id),
    standing: st ? { rank: st.rank, w: st.wins, l: st.losses, t: st.ties } : null,
    addPlan: addPlan(picks, budget, world.today, week?.end ?? null),
    catPlan: league.scoring === 'categories' && mine?.edges ? categoryPlan(ctx, snap, mine.edges, punts) : null,
    startsOn: (() => { const first = [...snap.weeks].map((w) => w[1]).sort()[0]; return first && first > world.today ? first : null })(),
  }
  // Names for every id the screen mentions, so the page needs no player file.
  const ids = new Set<string>()
  lineup?.rows.forEach((r) => ids.add(r.id))
  tomorrow?.rows.forEach((r) => ids.add(r.id))
  picks.forEach((p) => { ids.add(p.add); if (p.drop) ids.add(p.drop) })
  pairs.forEach((p) => p.moves.forEach((m) => { ids.add(m.add); ids.add(m.drop) }))
  news.forEach((n) => ids.add(n.playerId))
  view.trades.forEach((t) => [...t.give, ...t.get].forEach((x) => ids.add(x.id)))
  view.playoffs?.mine.forEach((x) => ids.add(x.id))
  view.playoffs?.targets.forEach((x) => ids.add(x.id))
  for (const id of ids) {
    const p = ctx.byId.get(id)
    if (p) view.players[id] = { name: p.name, team: p.team, positions: p.positions }
  }
  return view
}

// ── The home-screen tile ───────────────────────────────────────────────────

export type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'

export interface SeasonTile {
  id: string
  label: string
  sport: 'nba'
  urgency: Urgency
  action: string
  why: string
  /** The week's state for the card: categories or points, and the chance of winning. */
  score: { mine: number | null; theirs: number | null; win: number | null; expected: number | null } | null
  link: string
}

const HOUR = 3600000

/** Whether a lineup move saves a start that would otherwise be lost, rather than swapping in a better one. */
export const losesStart = (m: { bench: string | null; why: string }) =>
  !m.bench || /no game (today|tomorrow)|is (out|injured|suspended|inactive|doubtful)$/.test(m.why)

/**
 * Worst first, as football's tiles are. A lineup move before a tip within three
 * hours is the only thing that cannot wait; a move later today, or a stream the
 * week needs with adds to spare, is soon; a close week is worth a look.
 */
export function seasonTile(v: SeasonView, now: number): SeasonTile {
  const link = `/nba/league/${v.league.id}`
  const base = { id: v.league.id, label: v.league.label, sport: 'nba' as const, link }
  if (v.phase === 'before-draft') {
    return { ...base, urgency: 'quiet', action: 'Draft prep', why: 'Not drafted yet — mocks and the draft room are on its page', score: null }
  }
  const w = v.week
  const score = w ? {
    mine: w.score.mine, theirs: w.score.theirs,
    win: w.odds?.win ?? w.points?.win ?? null,
    expected: w.odds?.expected ?? null,
  } : null
  const moves = v.lineup?.moves ?? []
  const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
  // A start lost outright — an empty seat, or a starter with no game or ruled out — is worse than a weaker start.
  const lost = moves.filter(losesStart)
  const soonest = lost.map((m) => (m.by ? Date.parse(m.by) : Infinity)).reduce((a, b) => Math.min(a, b), Infinity)
  const say = (m: (typeof moves)[number]) => `Start ${name(m.start)}${m.bench ? ` over ${name(m.bench)}` : ''} — ${m.why}`
  if (lost.length && soonest - now < 3 * HOUR) {
    return { ...base, urgency: 'act', action: 'Set lineup', why: say(lost[0]), score }
  }
  if (moves.length) {
    return { ...base, urgency: 'soon', action: 'Set lineup', why: moves.length === 1 ? say(moves[0]) : `${moves.length} lineup changes before tonight's games — first: ${say(lost[0] ?? moves[0])}`, score }
  }
  const ahead = (v.tomorrow?.moves ?? []).filter(losesStart)
  if (ahead.length) {
    return { ...base, urgency: 'soon', action: "Set tomorrow's lineup", why: ahead.length === 1 ? say(ahead[0]) : `${ahead.length} starts lost tomorrow as set — first: ${say(ahead[0])}`, score }
  }
  const streams = v.pickups.filter((p) => p.kind === 'stream')
  const swing = w?.odds ? w.odds.races.filter((r) => r.state === 'swing').map((r) => r.cat) : []
  if (streams.length && (v.budget?.forStreams ?? 0) > 0 && score?.win != null && score.win > 0.15 && score.win < 0.85) {
    const s = streams[0]
    return { ...base, urgency: 'soon', action: 'Stream', why: `${s.name}: ${s.why}${swing.length ? ` · in play: ${swing.join(', ')}` : ''}`, score }
  }
  const upgrades = v.pickups.filter((p) => p.kind === 'upgrade')
  if (upgrades.length) {
    const u = upgrades[0]
    return { ...base, urgency: 'watch', action: 'Pick up', why: `${u.name} for ${u.dropName} — ${u.why.toLowerCase()}`, score }
  }
  const worse = v.news.find((n) => n.whose === 'mine' && n.kind === 'worse')
  if (worse) return { ...base, urgency: 'watch', action: 'News', why: worse.headline, score }
  if (score?.win != null && score.win > 0.25 && score.win < 0.75) {
    return { ...base, urgency: 'watch', action: 'Close week', why: swing.length ? `In play: ${swing.join(', ')}` : 'A close week', score }
  }
  return { ...base, urgency: 'quiet', action: 'Nothing to do', why: w ? `Week ${w.week}` : 'Between weeks', score }
}

// ── Pickup alerts ──────────────────────────────────────────────────────────

/** A season pickup is worth a notification at this many matchups won over the rest of the season; a pair at this. */
export const NOTIFY_WINS = 0.25
export const NOTIFY_PAIR_WINS = 0.5
/** A stream is worth one when it moves this week's chance of winning by this much, with adds to spend. */
export const NOTIFY_STREAM = 0.1

const signed = (w: number) => `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(2)} wins`
const pctOf = (x: number) => `${Math.round(x * 100)}%`

/**
 * New pickups worth your attention: the best season move, the best pair, the best stream this week. Each is sent once
 * (its id names the players), and a better one is a new alert; once the player is gone from the wire, so is the alert.
 * Costs scale with what the move is worth, and stay under a lineup move's (2026-10-19: asked for, so a pickup that
 * shows up mid-season is not found only by opening the screen).
 */
export function pickupAlerts(v: SeasonView, link: string): Alert[] {
  const out: Alert[] = []
  if (v.phase !== 'season') return out
  const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
  const L = v.league
  const best = v.pickups.filter((p) => p.kind !== 'stream' && p.drop && (p.seasonWins ?? 0) >= NOTIFY_WINS).sort((a, b) => (b.seasonWins ?? 0) - (a.seasonWins ?? 0))[0]
  if (best) {
    out.push({
      id: `nba-pickup:${L.id}:${best.add}:${best.drop}`, leagueId: L.id, rule: 'nba-pickup',
      headline: `${L.label}: add ${best.name}, drop ${best.dropName}`,
      detail: `${signed(best.seasonWins!)} over the rest of the season; this week ${pctOf(best.winBefore)} → ${pctOf(best.winAfter)}. ${best.waiver ? 'On waivers: put in a claim.' : 'A free agent: add him now.'}`,
      consequence: Math.round(35 + 20 * Math.min(1, best.seasonWins!)), deadline: null, link, playerId: best.add,
    })
  }
  const pair = v.pairs.find((p) => p.seasonWins >= NOTIFY_PAIR_WINS)
  if (pair) {
    const [a, b] = pair.moves
    out.push({
      id: `nba-pair:${L.id}:${[a, b].map((m) => `${m.add}>${m.drop}`).sort().join('+')}`, leagueId: L.id, rule: 'nba-pair',
      headline: `${L.label}: two moves, ${signed(pair.seasonWins)} together`,
      detail: `Add ${a.name} for ${a.dropName} (${signed(a.seasonWins)} alone) and ${b.name} for ${b.dropName} (${signed(b.seasonWins)} alone); this week ${pctOf(pair.winBefore)} → ${pctOf(pair.winAfter)}.`,
      consequence: Math.round(35 + 20 * Math.min(1, pair.seasonWins / 2)), deadline: null, link, playerId: a.add,
    })
  }
  const stream = (v.budget?.forStreams ?? 0) > 0 && v.week
    ? v.pickups.filter((p) => p.kind === 'stream' && p.winAfter - p.winBefore >= NOTIFY_STREAM).sort((a, b) => (b.winAfter - b.winBefore) - (a.winAfter - a.winBefore))[0]
    : undefined
  if (stream && v.week) {
    out.push({
      id: `nba-stream:${L.id}:${v.week.week}:${stream.add}`, leagueId: L.id, rule: 'nba-stream',
      headline: `${L.label}: stream ${stream.name} for ${stream.dropName}`,
      detail: `This week ${pctOf(stream.winBefore)} → ${pctOf(stream.winAfter)}, ${stream.startsThisWeek} game${stream.startsThisWeek === 1 ? '' : 's'}; ${signed(stream.seasonWins ?? 0)} over the season.`,
      consequence: Math.round(40 + 60 * Math.min(0.25, stream.winAfter - stream.winBefore)), deadline: Date.parse(`${v.week.end}T23:59:00-05:00`), link, playerId: stream.add,
    })
  }
  return out
}
