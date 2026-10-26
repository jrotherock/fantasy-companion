/**
 * The whole basketball league screen, and the one-line tile the home screen
 * shows for it. Assembled from the parts in inseason.ts, adds.ts, news.ts and
 * extras.ts; nothing here reads the network.
 */
import type { Weights } from './matchup.js'
import type { Cat } from './value.js'
import { startingSeats } from './week.js'
import { buildWeek, checkLineup, Context, type LineupCheck, type SeasonLeague, type Snapshot, type WeekView, type World } from './inseason.js'
import { addDays, addPlan, budgetOf, categoryPlan, pickupsAndPairs, type AddPlan, type Budget, type CategoryPlan, type IlReturn, type IlSwap, type PairMove, type Pickup, type WeekPlan } from './adds.js'
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
  /** Player ids you will not drop: no move offers them. */
  keep: string[]
  /** Players on my IL coming back: one no longer out comes off IL before any add, and the pickups assume he has. */
  ilBack: IlReturn[]
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
  /** The one thing the Adds screen says first: do this, worth a look, or nothing worth an add. */
  verdict: Verdict | null
  /** This week's best adds, by the chance of winning it by its last game, and what they do to the season. */
  weekPlan: WeekPlan | null
  /** IL full and a player out: the IL player to drop for him, and the add into his spot. */
  ilSwap: IlSwap | null
  /** My starters today listed questionable or doubtful, before their tip, and who on my bench would start instead. */
  lineupWatch: { id: string; name: string; status: string; tip: string; backups: { id: string; name: string; tip: string | null }[] }[]
  /** My waiver claims that cleared in the last two days. */
  claims: { id: string; at: number; add: string; addName: string; drop: string | null; dropName: string | null }[]
  /** The verdict for this week, beside the season's; `aligned` when the same move serves both. */
  weekVerdict: WeekVerdict | null
  catPlan: CategoryPlan | null
}


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
    lineup: null, tomorrow: null, week: null, budget: null, pickups: [], keep: [], ilBack: [], pairs: [], news: [], punts: [], power: [], allPlay: null, playoffs: null, trades: [],
    standing: null, players: {}, startsOn: null, addPlan: null, catPlan: null, verdict: null, weekPlan: null, ilSwap: null, weekVerdict: null, lineupWatch: [], claims: [],
  }
  if (!drafted || !me) return base

  // Yahoo's designations for every rostered player, before anything asks whether he plays.
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) ctx.setStatus(id, y.status) }

  const pw = power(ctx, snap)
  const mine = pw.find((r) => r.teamId === me.id)
  // The punts you set, not ones guessed from the roster: a 32% category read as given up on the Season tab and as
  // live on Adds (2026-10-23, Hoops AST), and only you know whether you are chasing it.
  const punts = league.scoring === 'categories' ? league.punts ?? [] : []
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
  const addsLeft = budget?.week ? Math.max(0, budget.week.max - budget.week.used) : null
  const { pickups: picks, pairs, ilBack, weekPlan, ilSwap } = pickupsAndPairs(ctx, snap, me.id, { punts, addsLeft })
  const news = leagueNews(ctx, snap, me.id, events, week?.opponent?.id ?? null).slice(0, 40)
  const st = snap.standings.find((s) => s.teamId === me.id || s.mine)

  const view: SeasonView = {
    ...base, lineup, tomorrow, week, budget, pickups: picks, keep: league.keep ?? [], ilBack, pairs, news, punts, power: pw,
    allPlay: allPlay(snap.past, me.id, league.scoring),
    playoffs: playoffPlan(ctx, snap, me.id),
    trades: tradeIdeas(ctx, snap, me.id),
    standing: st ? { rank: st.rank, w: st.wins, l: st.losses, t: st.ties } : null,
    addPlan: addPlan(picks, budget, world.today, week?.end ?? null),
    verdict: null, weekPlan, ilSwap, weekVerdict: null,
    lineupWatch: lineupWatchOf(ctx, lineup, punts),
    claims: claimsOf(ctx, snap, me.id),
    catPlan: league.scoring === 'categories' && mine?.edges ? categoryPlan(ctx, snap, mine.edges, punts) : null,
    startsOn: (() => { const first = [...snap.weeks].map((w) => w[1]).sort()[0]; return first && first > world.today ? first : null })(),
  }
  view.verdict = verdictOf(view)
  view.weekVerdict = weekVerdictOf(view)
  // The week's plan says what the verdict says: a pair is both of the plan's first steps, at the verdict's time.
  if (view.verdict?.kind === 'pair' && view.addPlan && view.pairs[0]) view.addPlan = planWithPair(view.addPlan, view.verdict, view.pairs[0])
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
const ACTIVE = (slot: string | null) => !!slot && !['BN', 'IL', 'IL+'].includes(slot)

/** My starters today in doubt before their tip, each with the best two on my bench whose games have not started. */
export function lineupWatchOf(ctx: Context, lineup: LineupCheck | null, punts: Cat[]): SeasonView['lineupWatch'] {
  if (!lineup) return []
  const bench = lineup.rows.filter((r) => r.slot === 'BN' && r.game && !r.game.started && !['out', 'injured', 'suspended', 'inactive', 'doubtful'].includes(r.status))
    .sort((a, b) => ctx.worth(b.id, punts) - ctx.worth(a.id, punts))
  return lineup.rows.filter((r) => ACTIVE(r.slot) && r.game && !r.game.started && r.game.tip && ['questionable', 'doubtful'].includes(r.status))
    .map((r) => ({ id: r.id, name: r.name, status: r.status, tip: r.game!.tip!, backups: bench.slice(0, 2).map((b) => ({ id: b.id, name: b.name, tip: b.game?.tip ?? null })) }))
}

/** My waiver claims that cleared in the last two days: a player come to me from waivers. */
export function claimsOf(ctx: Context, snap: Snapshot, me: string): SeasonView['claims'] {
  const out: SeasonView['claims'] = []
  for (const t of snap.transactions ?? []) {
    if (ctx.world.now - t.at > 2 * 86_400_000) continue
    const add = t.players.find((p) => p.kind === 'add' && p.toTeamId === me && p.fromType === 'waivers')
    if (!add) continue
    const drop = t.players.find((p) => p.kind === 'drop' && p.fromTeamId === me)
    const aid = ctx.resolve(add.player), did = drop ? ctx.resolve(drop.player) : null
    out.push({ id: t.id, at: t.at, add: aid ?? add.player.yahooId, addName: add.player.name, drop: did, dropName: drop?.player.name ?? null })
  }
  return out
}

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
  const swing = w?.odds ? w.odds.races.filter((r) => r.state === 'swing').map((r) => CAT_WORD[r.cat]) : []
  // The Adds screen's verdict, word for word, so the tile and the screen name the same move.
  const vd = v.verdict
  if (vd && vd.level !== 'none') {
    return { ...base, urgency: vd.level === 'do' ? 'soon' : 'watch', action: vd.kind === 'stream' ? 'Stream' : vd.level === 'do' ? 'Pick up' : 'Worth a look', why: `${vd.headline}${vd.when ? ` — ${vd.when}` : ''}${vd.reasons[0] ? ` · ${vd.reasons[0]}` : ''}`, score }
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
  // Only a move that holds up in most what-ifs is worth interrupting for.
  const sure = (c: { holds: number } | null) => (c?.holds ?? 0) >= DO.holds
  const best = v.pickups.filter((p) => p.kind !== 'stream' && p.drop && (p.seasonWins ?? 0) >= NOTIFY_WINS && sure(p.confidence)).sort((a, b) => (b.seasonWins ?? 0) - (a.seasonWins ?? 0))[0]
  if (best) {
    out.push({
      id: `nba-pickup:${L.id}:${best.add}:${best.drop}`, leagueId: L.id, rule: 'nba-pickup',
      headline: `${L.label}: add ${best.name}, drop ${best.dropName}`,
      detail: `${signed(best.seasonWins!)} over the rest of the season; this week ${pctOf(best.winBefore)} → ${pctOf(best.winAfter)}. ${best.waiver ? 'On waivers: put in a claim.' : 'A free agent: add him now.'}`,
      consequence: Math.round(35 + 20 * Math.min(1, best.seasonWins!)), deadline: null, link, playerId: best.add,
    })
  }
  const pair = v.pairs.find((p) => p.seasonWins >= NOTIFY_PAIR_WINS && sure(p.confidence))
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
    ? v.pickups.filter((p) => p.kind === 'stream' && p.winAfter - p.winBefore >= NOTIFY_STREAM && sure(p.confidence)).sort((a, b) => (b.winAfter - b.winBefore) - (a.winAfter - a.winBefore))[0]
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

// ── The Adds verdict ───────────────────────────────────────────────────────

export interface Verdict {
  level: 'do' | 'look' | 'none'
  /** "Add Miles Bridges, drop Andrew Nembhard", or for a pair both moves; for nothing, a line on why. */
  headline: string
  moves: { add: string; name: string; drop: string | null; dropName: string | null; waiver: boolean }[]
  kind: 'season' | 'pair' | 'stream' | null
  /** When: "now", "claim now", or the Monday after this week. */
  when: string | null
  /** The two or three things that make it the move. */
  reasons: string[]
  season: number | null
  week: { before: number; after: number } | null
  confidence: { holds: number; of: number; low: number; high: number } | null
}

/** A verdict's bar: "do this" takes a move worth this much that holds in this many of ten what-ifs. */
export const DO = { season: 0.25, pair: 0.5, stream: 0.08, holds: 8 }
/** "Worth a look": smaller, or less sure. */
export const LOOK = { season: 0.1, stream: 0.05, holds: 6 }

const CAT_WORD: Record<Cat, string> = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' }
const pctWord = (x: number) => `${Math.round(x * 100)}%`
const winsWord = (w: number) => `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(2)} wins`

/**
 * One verdict per league, from the moves already scored and checked: the best season move (as the week's plan
 * times it, now or the Monday after), a pair worth a good deal more than it, or a stream for a week in play. "Do
 * this" needs a move worth enough that holds up in eight of ten what-ifs; "worth a look" less; otherwise nothing,
 * with the best on offer named so the "nothing" is checkable (2026-10-21: the screen listed every move at once,
 * small and large, sure and unsure; the home tile named a different move from the plan).
 */
export interface WeekVerdict {
  level: 'do' | 'look' | 'none'
  headline: string
  winBefore: number
  winAfter: number
  moves: WeekPlan['moves']
  /** What the roster left after the week is worth over the season, against the roster as it is. */
  season: number | null
  /** The races the plan moves most (category leagues). */
  races: { cat: Cat; before: number; after: number }[]
  /** The season verdict's move is one of this week's: one move for both. */
  aligned: boolean
  /** "A long shot", "in play" or "nearly won": how much the week is worth chasing. */
  chance: 'long shot' | 'uphill' | 'in play' | 'ahead' | 'nearly won'
}

/** This week's bar: "do this" for adds worth 3 points of this week's chance, "worth a look" for one point. */
export const WEEK_DO = 0.03, WEEK_LOOK = 0.01

/**
 * The verdict for this week, beside the season's: the adds that give the week its best chance by the last game, every
 * category counted (a punted one won this week still counts), with what they do to the season, and whether the
 * season's move is one of them (2026-10-23: "I will always try to win each week"; the only verdict was the season's).
 */
export function weekVerdictOf(v: SeasonView): WeekVerdict | null {
  const p = v.weekPlan
  if (v.phase !== 'season' || !p) return null
  const w = p.winBefore
  const chance: WeekVerdict['chance'] = w < 0.15 ? 'long shot' : w < 0.35 ? 'uphill' : w <= 0.65 ? 'in play' : w < 0.9 ? 'ahead' : 'nearly won'
  const gain = p.winAfter - p.winBefore
  const level: WeekVerdict['level'] = !p.moves.length ? 'none' : gain >= WEEK_DO ? 'do' : gain >= WEEK_LOOK ? 'look' : 'none'
  const seasonAdds = new Set((v.verdict?.level === 'none' ? [] : v.verdict?.moves ?? []).map((m) => m.add))
  const races = (p.races ?? []).filter((r) => Math.abs(r.after - r.before) >= 0.02).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 4)
  return {
    level, chance, winBefore: p.winBefore, winAfter: p.winAfter, moves: level === 'none' ? [] : p.moves, season: level === 'none' ? null : p.seasonWins, races,
    aligned: level !== 'none' && p.moves.some((m) => seasonAdds.has(m.add)),
    headline: level === 'none'
      ? (p.moves.length ? 'No add moves this week by a point' : 'No add helps this week')
      : p.moves.map((m, i) => `${i ? 'then add' : 'Add'} ${m.name}${m.drop ? m.toIl ? ` (${m.dropName} to IL${m.ilDrop ? `, ${m.ilDropName} dropped from it` : ''})` : ` for ${m.dropName}` : ''}`).join(', '),
  }
}

export function verdictOf(v: SeasonView): Verdict | null {
  if (v.phase !== 'season') return null
  const cats = v.league.scoring === 'categories'
  const holds = (c: Verdict['confidence']) => c?.holds ?? 0
  const step = v.addPlan?.steps.find((st) => st.season != null) ?? null
  // A season move into an open spot counts as much as a swap (2026-10-24: Harker, a spot open after an IL move, read
  // "nothing worth an add" with Kuminga +3.0 wins on the list).
  const ups = v.pickups.filter((p) => p.kind !== 'stream')
  const up = (step ? ups.find((p) => p.name === step.add && p.dropName === step.drop) : null) ?? ups[0] ?? null
  // The plan's value for the move: on the Monday, the season gain less this week's loss.
  const upValue = up ? (step && step.add === up.name ? step.season ?? up.seasonWins ?? 0 : up.seasonWins ?? 0) : 0
  const upWhen = up ? (step && step.add === up.name ? step.when : up.waiver ? 'claim now' : 'now') : null
  const pair = v.pairs[0] ?? null
  const win = v.week?.odds?.win ?? v.week?.points?.win ?? null
  const inPlay = win != null && win > 0.3 && win < 0.7
  const streams = (v.budget?.forStreams ?? 0) > 0 && inPlay ? v.pickups.filter((p) => p.kind === 'stream').sort((a, b) => (b.winAfter - b.winBefore) - (a.winAfter - a.winBefore)) : []
  const st = streams[0] ?? null
  const stGain = st ? st.winAfter - st.winBefore : 0

  const reasonsOf = (p: SeasonView['pickups'][number], extra: string[] = []) => {
    const r: string[] = []
    const ups2 = p.seasonCats.filter((c) => c.diff > 0).slice(0, 3).map((c) => '+' + CAT_WORD[c.cat])
    if (cats && ups2.length && p.kind !== 'stream') r.push(`${ups2.join(', ')} over ${p.dropName}`)
    if (p.kind === 'stream' && p.playDays.length) r.push(`${p.playDays.length} game${p.playDays.length === 1 ? '' : 's'} this week, ${p.playDays.filter((d) => d.open).length} into empty spots`)
    if (cats && p.kind === 'stream' && p.weekCats.length) r.push(p.weekCats.filter((c) => c.after > c.before).slice(0, 2).map((c) => `${CAT_WORD[c.cat]} ${pctWord(c.before)}→${pctWord(c.after)}`).join(', '))
    return [...r.filter(Boolean), ...extra]
  }
  const one = (p: SeasonView['pickups'][number]) => ({ add: p.add, name: p.name, drop: p.drop, dropName: p.dropName, waiver: p.waiver })

  // IL full and a player out for a while: the swap first when it is worth an add and more than any other move. Yahoo
  // will not take him onto IL until a seat there is freed.
  const sw = v.ilSwap
  if (sw && sw.seasonWins >= DO.season && sw.seasonWins >= upValue) {
    const back = (d: string | null) => (d ? `back about ${new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : 'no return date')
    const other = sw.options.find((o) => o.drop !== sw.drop)
    return {
      level: 'do', kind: 'season', when: sw.waiver ? 'claim now' : 'now', season: sw.seasonWins, week: null, confidence: null,
      headline: `Drop ${sw.dropName} from IL, move ${sw.toIlName} to IL, add ${sw.name}`,
      moves: [{ add: sw.add, name: sw.name, drop: sw.drop, dropName: sw.dropName, waiver: sw.waiver }],
      reasons: [
        `IL is full: ${sw.toIlName} is out (${back(sw.toIlBack)}), ${sw.dropName} is ${back(sw.dropBack)}`,
        ...(other ? [`Keeping ${sw.dropName} instead (dropping ${other.dropName}, adding ${other.name}): ${winsWord(other.seasonWins)}`] : []),
      ],
    }
  }
  // A pair first when it is worth a good deal more than the best single move and holds up. Like a single move in the
  // week's plan, one that costs this week waits for the Monday after it, worth that loss more.
  const pairCost = pair ? Math.max(0, pair.winBefore - pair.winAfter) : 0
  const monday = v.week && pairCost > 0.03 ? addDays(v.week.end, 1) : null
  const pairValue = pair ? pair.seasonWins + (monday ? pairCost : 0) : 0
  if (pair && pairValue >= DO.pair && pairValue >= upValue + DO.season && holds(pair.confidence) >= DO.holds) {
    return {
      level: 'do', kind: 'pair', when: monday ? `${new Date(`${monday}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}, after this week` : 'now',
      season: pairValue, week: monday ? null : { before: pair.winBefore, after: pair.winAfter }, confidence: pair.confidence,
      headline: pair.moves.map((m, i) => `${i ? 'add' : 'Add'} ${m.name} for ${m.dropName}`).join(' and '),
      moves: pair.moves.map((m) => ({ add: m.add, name: m.name, drop: m.drop, dropName: m.dropName, waiver: m.waiver })),
      reasons: [`Each alone: ${pair.moves.map((m) => `${m.name} ${winsWord(m.seasonWins)}`).join(', ')}; together they keep your seats covered`],
    }
  }
  const season = (level: Verdict['level']): Verdict => ({
    level, kind: 'season', when: upWhen, season: upValue, week: upWhen && /after this week/.test(upWhen) ? null : { before: up!.winBefore, after: up!.winAfter }, confidence: up!.confidence,
    headline: up!.drop ? `Add ${up!.name}, drop ${up!.dropName}` : `Add ${up!.name} into your open spot`, moves: [one(up!)], reasons: reasonsOf(up!),
  })
  const stream = (level: Verdict['level']): Verdict => ({
    level, kind: 'stream', when: st!.waiver ? 'claim now' : 'now', season: st!.seasonWins, week: { before: st!.winBefore, after: st!.winAfter }, confidence: st!.confidence,
    headline: `Stream ${st!.name} for ${st!.dropName}`, moves: [one(st!)], reasons: reasonsOf(st!),
  })
  if (up && upValue >= DO.season && holds(up.confidence) >= DO.holds) return season('do')
  if (st && stGain >= DO.stream && holds(st.confidence) >= DO.holds) return stream('do')
  if (up && upValue >= LOOK.season && holds(up.confidence) >= LOOK.holds) return season('look')
  if (st && stGain >= LOOK.stream && holds(st.confidence) >= LOOK.holds) return stream('look')
  const best = up ? `the best, ${up.name} for ${up.dropName}, is ${winsWord(upValue)}${up.confidence ? ` and holds in ${up.confidence.holds} of ${up.confidence.of}` : ''}` : 'nobody on the wire beats your roster'
  return { level: 'none', kind: null, when: null, season: null, week: null, confidence: null, moves: [], headline: 'Nothing worth an add', reasons: [best] }
}

/**
 * The week's plan with the verdict's pair in front: both moves at the pair's time, and nothing else that adds or
 * drops the same players (2026-10-21: the public plan said to make each move now, since neither alone cost the week,
 * while the verdict said the Monday after, since together they did).
 */
export function planWithPair(plan: AddPlan, v: Verdict, pair: PairMove): AddPlan {
  const names = new Set(pair.moves.flatMap((m) => [m.name, m.dropName]))
  const rest = plan.steps.filter((st) => !names.has(st.add) && !(st.drop && names.has(st.drop)))
  const steps = pair.moves.map((m, i) => {
    const other = pair.moves[1 - i]
    return {
      when: v.when ?? 'now', add: m.name, drop: m.dropName,
      why: `With ${other.name} for ${other.dropName}: ${winsWord(pair.seasonWins)} for both, ${winsWord(m.seasonWins)} for this one alone`,
      week: i === 0 && v.week ? v.week : null, season: m.seasonWins,
    }
  })
  return { ...plan, steps: [...steps, ...rest] }
}

/** A tip time as the user reads it: Pacific, named. */
const tipWord = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) + ' PT' : 'later')
const dayShort = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
const pctWord2 = (x: number) => `${Math.round(x * 100)}%`
const HOUR_MS = 3_600_000

/**
 * The basketball notifications beyond a lost start and a pickup (2026-10-26: "does the app send me lineup reminders
 * such as Ant Edwards questionable before tip-off, or Cam's status changing in time to handle a pickup?"). Each says
 * what to do. Ids are stable for one fact, so each is sent once; consequences are what missing it costs.
 */
export function seasonAlerts(v: SeasonView, now: number): Alert[] {
  const out: Alert[] = []
  if (v.phase !== 'season') return out
  const L = v.league, link = `/nba/league/${L.id}`
  const name = (id: string | null) => (id ? v.players[id]?.name ?? id : '')
  const win = v.week?.odds?.win ?? v.week?.points?.win ?? 0.5
  const close = win > 0.2 && win < 0.8
  const rows = v.lineup?.rows ?? []

  // 1. A starter in doubt, about 90 minutes before his tip: who comes in if he sits.
  for (const w of v.lineupWatch) {
    const tip = Date.parse(w.tip)
    if (tip - now > 90 * 60_000 || tip <= now) continue
    const b = w.backups[0]
    out.push({
      id: `nba-watch:${L.id}:${v.today}:${w.id}`, leagueId: L.id, rule: 'nba-watch',
      headline: `${L.label}: ${w.name} is ${w.status}, tips ${tipWord(w.tip)}`,
      detail: b ? `If he sits, start ${b.name} (${tipWord(b.tip)})${w.backups[1] ? ` or ${w.backups[1].name}` : ''}. Teams usually settle it about 30 minutes before tip.` : 'Nobody on your bench plays later today; check his status before tip.',
      consequence: close ? 65 : 50, deadline: tip, link, playerId: w.id,
    })
  }
  // 1b. ...and when he is cleared before his tip: nothing to change.
  for (const n of v.news) {
    if (n.whose !== 'mine' || n.kind !== 'better' || n.at == null || now - n.at > 6 * HOUR_MS) continue
    const r = rows.find((x) => x.id === n.playerId && ACTIVE(x.slot) && x.game && !x.game.started)
    if (!r) continue
    out.push({
      id: `nba-cleared:${L.id}:${v.today}:${r.id}`, leagueId: L.id, rule: 'nba-cleared',
      headline: `${L.label}: ${r.name} is available — no change`, detail: `${n.headline}; he stays in your lineup.`,
      consequence: 35, deadline: r.game?.tip ? Date.parse(r.game.tip) : null, link, playerId: r.id,
    })
  }
  // 3. A clearly better start on the bench, in a week that is close.
  if (win > 0.35 && win < 0.65) {
    for (const m of v.lineup?.moves ?? []) {
      if (losesStart(m) || !m.by) continue
      const by = Date.parse(m.by)
      if (by - now > 2 * HOUR_MS || by <= now) continue
      out.push({
        id: `nba-better:${L.id}:${v.today}:${m.start}`, leagueId: L.id, rule: 'nba-better',
        headline: `${L.label}: start ${name(m.start)} over ${name(m.bench)}`,
        detail: `${m.why}; the week is ${pctWord2(win)}. Locks at ${tipWord(m.by)}.`,
        consequence: 45, deadline: by, link, playerId: m.start,
      })
    }
  }
  // 5. A player on IL who can no longer be there: Yahoo blocks adds until he moves. The choice made for you.
  for (const r of v.ilBack.filter((x) => x.ready)) {
    const what = r.drop === r.id ? `Let ${r.name} go (back, he adds nothing over your roster)`
      : r.drop ? `Activate ${r.name} and drop ${r.dropName} (${(r.seasonWins ?? 0) >= 0 ? '+' : ''}${(r.seasonWins ?? 0).toFixed(2)} wins)` : `Activate ${r.name} into your open spot`
    out.push({
      id: `nba-il:${L.id}:${v.today}:${r.id}`, leagueId: L.id, rule: 'nba-il',
      headline: `${L.label}: ${r.name} can't stay on IL (${r.status})`,
      detail: `${what}. Yahoo blocks adds until he is off IL.`,
      consequence: 60, deadline: null, link, playerId: r.id,
    })
  }
  // 6. Newly out with an IL seat open: move him there, and the add it makes room for.
  for (const m of v.lineup?.ilMoves ?? []) {
    if (m.action !== 'to-il') continue
    const plan = v.weekPlan?.moves.find((x) => x.toIl && x.drop === m.id)
    out.push({
      id: `nba-toil:${L.id}:${m.id}`, leagueId: L.id, rule: 'nba-toil',
      headline: `${L.label}: move ${m.name} to IL`,
      detail: plan ? `It frees his spot: add ${plan.name}.` : `It frees his spot for an add: ${v.verdict?.level !== 'none' && v.verdict ? v.verdict.headline : 'see Adds'}.`,
      consequence: 55, deadline: null, link, playerId: m.id,
    })
  }
  // 7. Newly out with IL full: which IL player to drop for him, and the add.
  if (v.ilSwap) {
    const sw = v.ilSwap
    out.push({
      id: `nba-ilswap:${L.id}:${sw.toIl}:${sw.drop}`, leagueId: L.id, rule: 'nba-ilswap',
      headline: `${L.label}: drop ${sw.dropName} from IL, move ${sw.toIlName} there, add ${sw.name}`,
      detail: `IL is full. ${sw.seasonWins >= 0 ? '+' : ''}${sw.seasonWins.toFixed(2)} wins over the season.`,
      consequence: 60, deadline: null, link, playerId: sw.toIl,
    })
  }
  // 8. Back from IL this week: a spot to plan for.
  for (const r of v.ilBack.filter((x) => !x.ready && x.returns)) {
    out.push({
      id: `nba-ilreturn:${L.id}:${r.id}:${r.returns}`, leagueId: L.id, rule: 'nba-ilreturn',
      headline: `${L.label}: ${r.name} due back ${dayShort(r.returns!)}`,
      detail: 'He will need an active spot: plan the drop, or the add that fills it until then.',
      consequence: 40, deadline: Date.parse(`${r.returns}T23:00:00Z`), link, playerId: r.id,
    })
  }
  // 9. A waiver claim cleared.
  for (const c of v.claims) {
    out.push({
      id: `nba-claim:${L.id}:${c.id}`, leagueId: L.id, rule: 'nba-claim',
      headline: `${L.label}: claim cleared — ${c.addName} is yours`, detail: c.dropName ? `${c.dropName} dropped.` : 'Into your open spot.',
      consequence: 40, deadline: null, link, playerId: c.add,
    })
  }
  // 10. The week ahead, once, when it begins (Sunday night after the roll): the chance, the open spots, the adds.
  const wv = v.weekVerdict, w = v.week
  if (w && wv && v.today <= w.start) {
    const opens = w.days.filter((d) => d.open > 0).map((d) => `${dayShort(d.date)} ${d.open}`).join(', ')
    out.push({
      id: `nba-weekplan:${L.id}:${w.week}`, leagueId: L.id, rule: 'nba-weekplan',
      headline: `${L.label}: week ${w.week} vs ${w.opponent?.name ?? 'your opponent'} — ${pctWord2(wv.winBefore)} to win`,
      detail: `Open spots: ${opens || 'none'}. ${wv.level === 'none' ? 'No add moves the week by a point.' : `${wv.headline}: ${pctWord2(wv.winBefore)} → ${pctWord2(wv.winAfter)}.`}`,
      consequence: 55, deadline: Date.parse(`${w.end}T23:00:00Z`), link, playerId: wv.moves[0]?.add,
    })
  }
  // 11/13. Mid-week, the week's best adds when they move a week still in play.
  if (w && wv && v.today > w.start && wv.level === 'do' && wv.winBefore > 0.2 && wv.winBefore < 0.8) {
    const daysLeft = w.days.filter((d) => d.date > v.today).length
    const adds = v.budget?.week ? v.budget.week.max - v.budget.week.used : null
    // 12. ...pressed when the week is nearly over and adds are left.
    const late = daysLeft <= 2 && (adds == null || adds > 0) && wv.winBefore > 0.25 && wv.winBefore < 0.75
    out.push({
      id: late ? `nba-lastadds:${L.id}:${v.today}` : `nba-weekmove:${L.id}:${w.week}:${wv.moves.map((m) => m.add).join('+')}`,
      leagueId: L.id, rule: late ? 'nba-lastadds' : 'nba-weekmove',
      headline: `${L.label}: ${wv.headline}`,
      detail: `This week ${pctWord2(wv.winBefore)} → ${pctWord2(wv.winAfter)}${wv.races.length ? ` (${wv.races.slice(0, 2).map((r) => `${r.cat.toUpperCase()} ${pctWord2(r.before)}→${pctWord2(r.after)}`).join(', ')})` : ''}${late && adds != null ? `; ${adds} add${adds === 1 ? '' : 's'} left, ${daysLeft} day${daysLeft === 1 ? '' : 's'} to go` : ''}.`,
      consequence: late ? 60 : 50, deadline: Date.parse(`${w.end}T23:00:00Z`), link, playerId: wv.moves[0]?.add,
    })
  }
  // 15. A new role, from the minutes: mine up or down, a free agent up.
  for (const n of v.news) {
    if (!((n.kind === 'minutes-up' && (n.whose === 'mine' || n.whose === 'free')) || (n.kind === 'minutes-down' && n.whose === 'mine'))) continue
    out.push({
      id: `nba-role:${L.id}:${n.key}`, leagueId: L.id, rule: 'nba-role',
      headline: `${L.label}: ${n.headline}`,
      detail: `${n.detail}. ${n.whose === 'free' ? 'A bigger role, and a free agent: worth a look on Adds.' : n.kind === 'minutes-up' ? 'A bigger role: keep him.' : 'A smaller role: watch him, and Adds if it holds.'}`,
      consequence: 35, deadline: null, link, playerId: n.playerId,
    })
  }
  return out
}
