/**
 * Adds: what is left to spend, and what is worth spending it on.
 *
 * Two kinds of pickup, judged differently:
 *   - an upgrade is better than someone on the roster for the rest of the season;
 *   - a stream is a player with games this week on days the roster has seats
 *     free, dropped again later. It is worth an add only if it moves the week.
 * Hoops caps adds at 100 a season and 10 a week; Harker at 5 a week. A stream
 * is the only kind of add that uses the budget for this week alone, so it is
 * the one paced against what is left.
 *
 * Never-list players are never offered. No bid is suggested in a FAAB league:
 * an invented number would be the most confident wrong figure on the screen
 * (football's rule).
 */
import { daysFrom, startingSeats } from './week.js'
import { categoryWeek, pointsWeek, type SideOutlook } from './matchup.js'
import { rosterIds, sideOutlook, weekOf, type Context, type Snapshot, type Whatif } from './inseason.js'
import { CATS, type Cat } from './value.js'
import { addBox, emptyBox, type Box } from './yahooSeason.js'
import { designation, type Designation } from './outlook.js'

export interface Budget {
  /** Adds used and allowed this week; null where the league has no weekly cap. */
  week: { used: number; max: number } | null
  /** Over the season; null where there is no season cap. */
  season: { used: number; max: number } | null
  weeksLeft: number
  /** Season adds left per remaining week, before keeping some back. */
  pace: number | null
  /** What can sensibly go on streams this week. */
  forStreams: number
  note: string
}

/**
 * The per-game edge an upgrade must have: half a standard deviation of one
 * category, summed across the nine; or two fantasy points a game.
 */
export const UPGRADE_PER_GAME = { categories: 0.5, points: 2 } as const

/** A pickup has to play at least this many more games, or it is no pickup. */
export const MIN_GAMES_LEFT = 3

/**
 * A season move is judged on every regular-season week left, each against that week's real opponent, in matchups
 * expected won; it has to add this many to be worth an add (2026-10-19: the next three weeks against this week's
 * opponent made Caruso, 58 games, a season upgrade; over the whole season he cost half a win).
 */
export const UPGRADE_WINS = 0.1

/**
 * A stream drops someone for good, so it may cost the season this many matchups, no more (2026-10-19: the week's
 * plan streamed Caruso for Nesmith, the season pickup made that night, at half a win).
 */
export const STREAM_SEASON_COST = 0.15

/**
 * A stream never drops a starter's load: a player projected for this many minutes (yours, if you set them) is kept
 * however close the projections call the swap (2026-10-19: Harker's plan streamed Kuminga, who starts but does not
 * close, for Jalen Green at 33 minutes, the two a twentieth of a win apart over the season).
 */
export const STREAM_KEEP_MIN = 30

/** How many of my players are weighed as drops. */
const DROPS = 5

/** Stream candidates scored for the week: this many, by games in my empty spots times value above the floor. */
const WEEK_POOL = 30
/** The floor: the value per game of about the 150th free agent, below which a player adds nothing a stream needs. */
const WEEK_FLOOR = 150

/**
 * The free agents worth scoring as this week's streams: games times value per game above a floor, so a third game
 * always counts for more than a second. Value per game is below zero for nearly every free agent (he is below the
 * average rostered player), and times games it ranked a man with three games below the same man with two
 * (2026-10-21: Anfernee Simons, Philadelphia's Thursday and Sunday into Hoops' two emptiest nights, ranked 173rd and
 * was never scored).
 */
export function shortlistForWeek(ids: string[], worth: (id: string) => number, games: (id: string) => number, floor: number, n: number): string[] {
  const above = (id: string) => Math.max(0.1, worth(id) - floor)
  return ids.filter((id) => games(id) > 0).sort((a, b) => above(b) * games(b) - above(a) * games(a)).slice(0, n)
}

/** Season moves checked against what-ifs: the best few, which are the ones a verdict or an alert can name. */
const CHECKED_SEASON = 6

/** Candidates for a season move: the best this many free agents by per-game value. */
const SEASON_POOL = 60

/** Adds kept back for injuries and the playoffs. */
export const RESERVE = 8

export function budgetOf(snap: Snapshot, myTeamId: string, league: { adds: { perWeek: number | null; season: number | null } }, today: string): Budget {
  const meta = snap.rosters.find((r) => r.team.id === myTeamId)?.team
    ?? snap.scoreboard.flatMap((m) => m.sides).find((s) => s.id === myTeamId)
  const weekMax = snap.settings?.maxWeeklyAdds ?? league.adds.perWeek
  const seasonMax = snap.settings?.maxAdds ?? league.adds.season
  const usedWeek = meta?.addsThisWeek ?? 0
  const usedSeason = meta?.moves ?? 0
  const current = weekOf(snap.weeks, today)
  const weeksLeft = current ? snap.weeks.filter(([n]) => n >= current[0]).length : snap.weeks.length
  const week = weekMax != null ? { used: usedWeek, max: weekMax } : null
  const season = seasonMax != null ? { used: usedSeason, max: seasonMax } : null
  const leftWeek = week ? Math.max(0, week.max - week.used) : Infinity
  const leftSeason = season ? Math.max(0, season.max - season.used) : Infinity
  const pace = season && weeksLeft ? Math.max(0, leftSeason - RESERVE) / weeksLeft : null
  // Streams this week: what the weekly cap leaves, held to the season's pace with a week's slack.
  const forStreams = Math.max(0, Math.floor(Math.min(leftWeek, pace != null ? Math.max(pace * 1.5, Math.min(2, leftSeason - RESERVE)) : leftWeek)))
  const note = season
    ? `${leftSeason} of ${season.max} adds left for ${weeksLeft} week${weeksLeft === 1 ? '' : 's'} — about ${pace!.toFixed(1)} a week after keeping ${RESERVE} back`
    : week ? `${leftWeek} of ${week.max} adds left this week` : 'No add limit'
  return { week, season, weeksLeft, pace, forStreams, note }
}

export interface Pickup {
  add: string
  name: string
  team: string | null
  positions: string[]
  drop: string | null
  dropName: string | null
  kind: 'upgrade' | 'stream' | 'stash'
  /** Expected categories (or win chance, in points) this week, gained by the move. */
  weekGain: number
  /** The week's chance of winning, before and after. */
  winBefore: number
  winAfter: number
  /** Value over the rest of the season, gained (negative: a stream that costs a little). */
  seasonGain: number
  /**
   * Matchups expected won over the rest of the regular season, gained by the move: every week's nightly lineups
   * against that week's opponent, each player at his own rate of games played. Seat-aware: a pickup who fills
   * seats left empty counts in full, one who would mostly sit barely (2026-10-15). Null once the regular season is over.
   */
  seasonWins: number | null
  /** The weeks that measure covers, and whether each was against the real opponent (else this week's stood in). */
  seasonWeeks: number
  scheduled: boolean
  /** Games he plays in seats this week, from the day he can be added. */
  startsThisWeek: number
  waiver: boolean
  why: string
  /** Why, by category: where he beats the dropped player per game (the season), and the week's races it moves most. */
  seasonCats: { cat: Cat; diff: number }[]
  /** The days he plays this week once he can be added, and whether I have a seat nobody fills that day. */
  playDays: { date: string; open: boolean }[]
  weekCats: { cat: Cat; before: number; after: number }[]
  /** Other players he could replace, best first: the drop is the user's call. */
  alternatives: { drop: string; dropName: string; weekGain: number; winAfter: number; seasonGain: number; seasonWins: number | null }[]
  /** How well the move holds up when the players in it turn out other than projected; null where not checked. */
  confidence: Confidence | null
  /** A stash: an injured player Yahoo will not let onto IL straight from the wire, so the steps. */
  steps: string | null
}

/** How far out a return makes an injured player a stash rather than an add. */
const STASH_DAYS = 10

/**
 * Seat groups a drop must not leave short: two C seats need a third center for the nights one sits (2026-10-10,
 * public league: the list offered Siakam, one of three centers, for every pickup); guard and forward seats need
 * only enough to fill them. A group short before the move only has to stay as deep as it was.
 */
const GROUPS: Record<string, string[]> = { C: ['C'], G: ['PG', 'SG'], F: ['SF', 'PF'] }
function seatNeeds(seats: string[]): Record<string, number> {
  const n: Record<string, number> = { C: 0, G: 0, F: 0 }
  for (const s of seats) {
    if (s === 'C') n.C++
    else if (s === 'PG' || s === 'SG' || s === 'G') n.G++
    else if (s === 'SF' || s === 'PF' || s === 'F') n.F++
  }
  return n
}
const eligibleIn = (group: string, eligible: string[]) => eligible.some((e) => GROUPS[group].includes(e))
export function keepsSeatDepth(before: { eligible: string[] }[], after: { eligible: string[] }[], seats: string[]): boolean {
  const need = seatNeeds(seats)
  for (const g of Object.keys(GROUPS)) {
    if (!need[g]) continue
    const b = before.filter((x) => eligibleIn(g, x.eligible)).length
    const a = after.filter((x) => eligibleIn(g, x.eligible)).length
    // A spare only for centers, the seats nobody else can fill (two C seats a night); guards and forwards need only
    // enough to fill theirs: a fourth forward for three forward seats sat about 1% of his games (2026-10-10 replay).
    const want = g === 'C' ? need[g] + 1 : need[g]
    if (a < Math.min(b, want)) return false
  }
  return true
}

/**
 * The best pickups, from a pool of players nobody rosters. `punts` are
 * categories my roster has given up, which no pickup should chase.
 */
export function pickups(ctx: Context, snap: Snapshot, myTeamId: string, opts: { punts?: Cat[]; limit?: number } = {}): Pickup[] {
  return pickupsAndPairs(ctx, snap, myTeamId, opts).pickups
}

/** Two moves made together: what they add over the season as a pair, and each alone. */
/**
 * A player on my IL coming back. Ready: no longer out, so he has to come off IL before any add, for `drop` (the one the
 * season misses least with him in; himself when letting him go is better; null with a spot open), worth `seasonWins`
 * against leaving the roster as it is. Not ready: still out, with a return date this week.
 */
export interface IlReturn {
  id: string
  name: string
  status: Designation
  ready: boolean
  returns: string | null
  drop: string | null
  dropName: string | null
  seasonWins: number | null
}
const OUT: Designation[] = ['out', 'injured', 'inactive', 'suspended']

export interface PairMove {
  moves: { add: string; name: string; drop: string; dropName: string; waiver: boolean; seasonWins: number }[]
  /** Matchups expected won over the rest of the regular season, gained by both moves. */
  seasonWins: number
  /** This week's chance of winning, before and after both. */
  winBefore: number
  winAfter: number
  confidence: Confidence | null
}

/**
 * How a move holds up against what-ifs: in how many of them it still helps (season moves: matchups won over the
 * season; streams: this week's chance of winning), and the range of what it adds, low to high (the second-worst and
 * second-best of ten). A projection is a best guess: a move worth +0.12 wins can be worth nothing if its minutes
 * come in low (2026-10-21: the screen showed every move as an exact number).
 */
export interface Confidence { holds: number; of: number; low: number; high: number }

/** What-ifs per move. */
export const WHATIFS = 10
/** The spread of each what-if, one standard deviation: minutes, games played, form in a category. */
const SPREAD = { minutes: 0.15, games: 0.1, form: 0.08 }

/** A small seeded generator, so the same move gets the same what-ifs on every reading of the screen. */
function seeded(key: string): () => number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const normal = (r: () => number) => (r() + r() + r() - 1.5) / 0.5
const within = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** One player's what-if number i: his minutes, games and form drawn around his projection. */
export function whatifFor(id: string, i: number): Whatif {
  const r = seeded(`${id}#${i}`)
  const form = Object.fromEntries(CATS.map((c) => [c, within(1 + SPREAD.form * normal(r), 0.75, 1.25)])) as Record<Cat, number>
  return { minutes: within(1 + SPREAD.minutes * normal(r), 0.6, 1.4), games: within(1 + SPREAD.games * normal(r), 0.6, 1.15), form }
}

/** The singles a pair is built from: the best this many swaps by season wins. */
const PAIR_POOL = 10
/** The box keys behind each category: a percentage is its makes and attempts. */
const PUNT_KEYS: Record<Cat, (keyof Box)[]> = {
  fg: ['fgm', 'fga'], ft: ['ftm', 'fta'], tpm: ['tpm'], pts: ['pts'], reb: ['reb'], ast: ['ast'], stl: ['stl'], blk: ['blk'], to: ['to'],
}

/** A pair is shown when its second move adds at least this much to the best single move. */
export const PAIR_MARGIN = UPGRADE_WINS

export function pickupsAndPairs(ctx: Context, snap: Snapshot, myTeamId: string, opts: { punts?: Cat[]; limit?: number } = {}): { pickups: Pickup[]; pairs: PairMove[]; ilBack: IlReturn[] } {
  const { today } = ctx.world
  const mine = snap.rosters.find((r) => r.team.id === myTeamId)
  if (!mine) return { pickups: [], pairs: [], ilBack: [] }
  const rostered = new Set<string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) rostered.add(id) }
  const waivers = new Set(snap.waivers)
  const waiverIds = new Set<string>()
  for (const p of ctx.world.players) if (p.yahoo?.yahooId && waivers.has(p.yahoo.yahooId)) waiverIds.add(p.id)

  const punts = opts.punts ?? []
  const worth = (id: string) => ctx.worth(id, punts)
  // Rest-of-season value: per-game worth above the free-agent line, times games left.
  // Nobody who will not play enough to matter: a man out for the season is worth nought, which can outrank a weak roster's tail.
  const pool = ctx.world.players.filter((p) => p.projection && p.team && !rostered.has(p.id) && !ctx.world.never.has(p.id) && ctx.gamesLeft(p.id) >= MIN_GAMES_LEFT)
  const byWorth = [...pool].sort((a, b) => worth(b.id) - worth(a.id))
  const line = worth(byWorth[Math.min(10, byWorth.length - 1)]?.id ?? '') || 0
  const season = (id: string) => (worth(id) - line) * ctx.gamesLeft(id)

  let myIds = rosterIds(ctx, mine.players)
  const seats = startingSeats(ctx.league.roster)
  const wk = weekOf(snap.weeks, today)
  const m = snap.scoreboard.find((x) => x.sides.some((s) => s.id === myTeamId))
  const start = m?.start ?? wk?.[1], end = m?.end ?? wk?.[2]
  // An add counts from tomorrow: Yahoo applies a free-agent add to the next day's lineup once
  // today's games are under way, and a waiver claim only after it clears.
  const tomorrow = addDays(today, 1)
  const waiverDays = snap.settings?.waiverDays ?? 2
  const days = start && end ? daysFrom(start, end, tomorrow) : []
  const daysFor = (id: string) => (waiverIds.has(id) ? days.filter((d) => d >= addDays(today, waiverDays + 1)) : days)

  const theirs = m?.sides.find((s) => s.id !== myTeamId) ?? null
  const mySide = m?.sides.find((s) => s.id === myTeamId) ?? null
  const oppIds = rosterIds(ctx, snap.rosters.find((r) => r.team.id === theirs?.id)?.players ?? [])
  const allDays = start && end ? daysFrom(start, end, today) : []
  const opp = theirs ? sideOutlook(ctx, theirs, oppIds, seats, allDays).side : null

  const score = (ids: { id: string; eligible: string[] }[]): { gain: number; win: number; races?: { cat: Cat; win: number }[] } => {
    if (!opp) return { gain: 0, win: 0.5 }
    const a = sideOutlook(ctx, mySide, ids, seats, allDays).side
    if (ctx.league.scoring === 'categories') {
      const o = categoryWeek(a, opp)
      return { gain: o.expected, win: o.win, races: o.races.map((r) => ({ cat: r.cat, win: r.win + r.tie / 2 })) }
    }
    const o = pointsWeek(a, opp, ctx.league.points ?? {}, { mine: mySide?.points ?? null, theirs: theirs?.points ?? null })
    return { gain: o.mine - o.theirs, win: o.win }
  }
  let base = score(myIds)
  // The rest of the regular season, week by week, against the team Yahoo has me playing each week (this week's
  // opponent stands in until the league's schedule is read). Every category counts toward a week: a punted one is
  // lost either way. The current week starts from nothing banked, the same for every roster compared.
  const { weeks: left, scheduled } = seasonLeft(snap, myTeamId, tomorrow, theirs?.id ?? null)
  const oppSides = left.map((w) => (w.opp ? sideOutlook(ctx, null, rosterIds(ctx, snap.rosters.find((r) => r.team.id === w.opp)?.players ?? []), seats, w.days).side : null))
  // A punted category is held where my roster as it stands has it, week by week: no move wins or loses it, while the
  // week is still counted as won or lost on all nine (2026-10-23: Hoops' AST punt, and Public's FG% and REB, were
  // credited to adds; Missi led Public for rebounds and FG% given up).
  // My lineups are seated as a punter seats them, too: nobody starts for what he adds in a punted category.
  const myPunts = ctx.league.scoring === 'categories' ? ctx.league.punts ?? [] : []
  const held = myPunts.flatMap((c) => PUNT_KEYS[c])
  let asIs = held.length ? left.map((w) => sideOutlook(ctx, null, myIds, seats, w.days, myPunts).side) : []
  const hold = (a: SideOutlook, i: number): SideOutlook => {
    if (!held.length) return a
    const rest = { ...a.rest }, restVar = { ...a.restVar }
    for (const k of held) { rest[k] = asIs[i].rest[k]; restVar[k] = asIs[i].restVar[k] }
    return { ...a, rest, restVar }
  }
  const winsCache = new Map<string, number>()
  const seasonWins = (ids: { id: string; eligible: string[] }[]): number => {
    const key = ids.map((x) => x.id).sort().join(',')
    // Under a what-if the same roster scores differently, so nothing is kept from one.
    const hit = ctx.whatif ? null : winsCache.get(key); if (hit != null) return hit
    let v = 0
    left.forEach((w, i) => {
      const o = oppSides[i]
      if (!o) return
      const a = hold(sideOutlook(ctx, null, ids, seats, w.days, myPunts).side, i)
      if (ctx.league.scoring === 'categories') { const x = categoryWeek(a, o); v += x.win + x.tie / 2 }
      else v += pointsWeek(a, o, ctx.league.points ?? {}, { mine: null, theirs: null }).win
    })
    if (!ctx.whatif) winsCache.set(key, v)
    return v
  }
  const judged = left.some((w) => w.opp)
  const activeCap = seats.length + (ctx.league.roster.BN ?? 0)

  // Off IL first. A player on IL who is no longer out cannot play from there, and Yahoo blocks adds while he sits on
  // it (2026-10-23: Nesmith, questionable, while Adds offered Bailey for Simons as if Simons' spot were free). He comes
  // back for the player the season misses least with him in, or goes himself if that is better, and every move after
  // is judged on the roster that leaves. One still out with a return date this week is named, to plan a spot for.
  const ilBack: IlReturn[] = []
  const weekEnd = end ?? today
  for (const y of mine.players.filter((x) => x.slot === 'IL' || x.slot === 'IL+')) {
    const id = ctx.resolve(y)
    if (!id) continue
    const name = ctx.byId.get(id)?.name ?? y.name
    const status = ctx.designation(id)
    if (OUT.includes(status)) {
      const back = ctx.returnOf(id).date
      if (back && back <= weekEnd) ilBack.push({ id, name, status, ready: false, returns: back, drop: null, dropName: null, seasonWins: null })
      continue
    }
    const him = { id, eligible: y.eligible }
    const now = judged ? seasonWins(myIds) : 0
    const valueOf = (ids: { id: string; eligible: string[] }[]) => (judged ? seasonWins(ids) - now : ids.reduce((s, x) => s + season(x.id), 0) - myIds.reduce((s, x) => s + season(x.id), 0))
    let best: { drop: { id: string; eligible: string[] } | null; gain: number }
    if (myIds.length < activeCap) best = { drop: null, gain: valueOf([...myIds, him]) }
    else {
      // Letting him go keeps the roster as it is: worth nothing more, nothing less.
      best = { drop: him, gain: 0 }
      for (const d of myIds) {
        const after = [...myIds.filter((x) => x.id !== d.id), him]
        if (!keepsSeatDepth(myIds, after, seats)) continue
        const gain = valueOf(after)
        if (gain > best.gain) best = { drop: d, gain }
      }
    }
    if (best.drop?.id !== id) myIds = best.drop ? [...myIds.filter((x) => x.id !== best.drop!.id), him] : [...myIds, him]
    ilBack.push({ id, name, status, ready: true, returns: null, drop: best.drop?.id ?? null, dropName: best.drop ? ctx.byId.get(best.drop.id)?.name ?? null : null, seasonWins: best.gain })
  }
  if (ilBack.some((x) => x.ready)) {
    base = score(myIds)
    if (held.length) asIs = left.map((w) => sideOutlook(ctx, null, myIds, seats, w.days, myPunts).side)
    winsCache.clear()
  }

  const baseWins = judged ? seasonWins(myIds) : 0
  // Open active seats: a pickup into one drops nobody (2026-10-15: the public team had one after moving Porziņģis to
  // IL, and every suggestion was still a swap).
  const openSpots = Math.max(0, activeCap - myIds.length)
  // My open seats each day as the roster stands: the days a pickup's games count without benching anyone.
  const openOn = new Map<string, number>()
  if (allDays.length) {
    const wk0 = sideOutlook(ctx, mySide, myIds, seats, allDays).week
    allDays.forEach((d, i) => openOn.set(d, Math.max(0, seats.length - (wk0.days[i]?.starting.length ?? 0))))
  }

  // Who could go: the five the season would miss least, in matchups won without him (2026-10-19: by per-game value,
  // Nesmith, picked up that night for his fit, was the first drop offered for a stream). By per-game value when
  // there is no season left to judge.
  const missed = (id: string) => (judged ? baseWins - seasonWins(myIds.filter((x) => x.id !== id)) : season(id))
  const drops = myIds
    .map((x) => ({ ...x, season: season(x.id), missed: missed(x.id) }))
    .sort((a, b) => a.missed - b.missed)
    .slice(0, DROPS)
  const ilSlots = ctx.league.roster.IL ?? 0
  const ilOpen = Math.max(0, ilSlots - mine.players.filter((y) => y.slot === 'IL' || y.slot === 'IL+').length)
  // Out for a while: worth a roster spot only by way of IL.
  const longOut = (id: string) => {
    const r = ctx.returnOf(id)
    if (r.date) return r.date > addDays(today, STASH_DAYS)
    const p = ctx.byId.get(id)
    return ['out', 'injured'].includes(designation(p?.yahoo?.status, p?.injury?.status))
  }

  // Candidates: the best for the season, and the best for this week's games.
  const weekGames = (id: string) => daysFor(id).filter((d) => {
    const t = ctx.byId.get(id)?.team
    return !!t && schedulePlays(ctx, d, t)
  }).length
  const forSeason = byWorth.slice(0, SEASON_POOL)
  // This week's: his games that land in my empty spots (the nights an added player counts without benching anyone),
  // as many as the week has, with an injured man's games counted only where he is expected to play.
  const openGames = (id: string) => daysFor(id).filter((d) => {
    const t = ctx.byId.get(id)?.team
    return !!t && schedulePlays(ctx, d, t) && (openOn.get(d) ?? 0) > 0 && ctx.play(id, d) > 0.5
  }).length
  const floor = worth(byWorth[Math.min(WEEK_FLOOR, byWorth.length - 1)]?.id ?? '') || 0
  const forWeek = shortlistForWeek(pool.map((p) => p.id), worth, openOn.size ? openGames : weekGames, floor, WEEK_POOL)
    .map((id) => ctx.byId.get(id)!)
  const cands = [...new Map([...forSeason, ...forWeek].map((p) => [p.id, p])).values()]

  // Per category, per game: his z less the dropped player's, in the categories in play; and the week's races that move.
  const whyCats = (add: string, drop: string, after?: { cat: Cat; win: number }[]) => {
    const za = ctx.zOf(add), zd = ctx.zOf(drop)
    const seasonCats = za && zd
      ? CATS.filter((k) => !punts.includes(k)).map((k) => ({ cat: k, diff: za[k] - zd[k] })).filter((x) => Math.abs(x.diff) >= 0.3).sort((a, b) => b.diff - a.diff)
      : []
    const weekCats = after && base.races
      ? after.map((r) => ({ cat: r.cat, before: base.races!.find((x) => x.cat === r.cat)?.win ?? 0.5, after: r.win }))
        .filter((x) => Math.abs(x.after - x.before) >= 0.03).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 4)
      : []
    return { seasonCats, weekCats }
  }

  const out: Pickup[] = []
  const tried: { add: { id: string; eligible: string[] }; drop: { id: string; eligible: string[] }; wins: number }[] = []
  for (const c of cands) {
    if (openSpots > 0) {
      const add = { id: c.id, eligible: c.positions }
      const p = ctx.byId.get(c.id)!
      const after = score([...myIds, add])
      const winsGain = judged ? seasonWins([...myIds, add]) - baseWins : null
      if ((winsGain ?? 0) > 0 || after.gain > base.gain) {
        out.push({
          add: c.id, name: p.name, team: p.team, positions: p.positions, drop: null, dropName: null, kind: 'upgrade',
          alternatives: [], seasonCats: [], weekCats: [], steps: null,
          playDays: daysFor(c.id).filter((day) => { const t = ctx.byId.get(c.id)?.team; return !!t && schedulePlays(ctx, day, t) && ctx.play(c.id, day) > 0.5 }).map((date) => ({ date, open: (openOn.get(date) ?? 0) > 0 })),
          weekGain: after.gain - base.gain, winBefore: base.win, winAfter: after.win, seasonGain: season(c.id),
          seasonWins: winsGain, seasonWeeks: left.length, scheduled,
          startsThisWeek: weekGames(c.id), waiver: waiverIds.has(c.id),
          why: `Into your open roster spot (${openSpots} free): nobody dropped`, confidence: null,
        })
      }
    }
    for (const d of drops) {
      const swapped = myIds.filter((x) => x.id !== d.id)
      // The dropped player still plays today; the add only from his first day.
      const add = { id: c.id, eligible: c.positions }
      if (!keepsSeatDepth(myIds, [...swapped, add], seats)) continue
      const after = scoreWithAddFrom(ctx, mySide, swapped, d, add, seats, allDays, daysFor(c.id), opp, theirs)
      const seasonGain = season(c.id) - d.season
      const weekGain = after.gain - base.gain
      // An upgrade has to win more matchups over the regular season left by a margin worth an add. With no
      // regular season left (the playoffs), better per game by a margin, over the games he has left.
      const winsGain = judged ? seasonWins([...swapped, add]) - baseWins : null
      if (winsGain != null) tried.push({ add, drop: d, wins: winsGain })
      const upgrade = winsGain != null ? winsGain >= UPGRADE_WINS : seasonGain > UPGRADE_PER_GAME[ctx.league.scoring] * Math.max(10, ctx.gamesLeft(c.id))
      const secure = (ctx.byId.get(d.id)?.projection?.perGame.min ?? 0) >= STREAM_KEEP_MIN
      const stream = !upgrade && !secure && weekGain > (ctx.league.scoring === 'categories' ? 0.15 : 8) && (winsGain != null ? winsGain > -STREAM_SEASON_COST : seasonGain > -40)
      if (!upgrade && !stream) continue
      const p = ctx.byId.get(c.id)!
      const starts = weekGames(c.id)
      // Hurt for a while and an IL seat free: a stash, with the steps Yahoo needs.
      const stash = upgrade && ilOpen > 0 && longOut(c.id)
      const back = ctx.returnOf(c.id).date
      out.push({
        add: c.id, name: p.name, team: p.team, positions: p.positions,
        drop: d.id, dropName: ctx.byId.get(d.id)?.name ?? d.id,
        kind: stash ? 'stash' : upgrade ? 'upgrade' : 'stream',
        alternatives: [],
        ...whyCats(c.id, d.id, after.races),
        // Days his team plays and he is expected to: an injured stash plays none.
        playDays: daysFor(c.id).filter((day) => { const t = ctx.byId.get(c.id)?.team; return !!t && schedulePlays(ctx, day, t) && ctx.play(c.id, day) > 0.5 }).map((date) => ({ date, open: (openOn.get(date) ?? 0) > 0 })),
        steps: stash
          ? `${waiverIds.has(c.id) ? 'Claim' : 'Add'} him dropping ${ctx.byId.get(d.id)?.name}, move him to IL once he is yours (Yahoo will not add straight to IL), then use the freed spot for another add.${back ? ` Back about ${back}.` : ''}`
          : null,
        weekGain, winBefore: base.win, winAfter: after.win, seasonGain, startsThisWeek: starts,
        seasonWins: winsGain, seasonWeeks: left.length, scheduled, confidence: null,
        waiver: waiverIds.has(c.id),
        // The reason reads beside "Drop <name>" on the card and in the plan, so it does not name him again.
        why: stash
          ? 'Out now; better once back, for the rest of the season'
          : upgrade
          ? 'Better for the rest of the season'
          : ctx.league.scoring === 'categories'
            ? `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(2)} categories expected`
            : `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(0)} points expected`,
      })
    }
  }
  // One line per player added: his best drop, the other drops he beats as alternatives.
  // Season moves by what they add to my starts (seat-aware); streams by this week.
  const rank = (x: Pickup) => (x.kind !== 'stream' ? 1000 + (x.seasonWins ?? 0) * 1000 + x.seasonGain / 1000 : x.weekGain * 100 + x.seasonGain / 10)
  const best = new Map<string, Pickup>()
  for (const p of [...out].sort((a, b) => rank(b) - rank(a))) {
    const cur = best.get(p.add)
    if (!cur) { best.set(p.add, p); continue }
    if (cur.alternatives.length < 3) cur.alternatives.push({ drop: p.drop!, dropName: p.dropName!, weekGain: p.weekGain, winAfter: p.winAfter, seasonGain: p.seasonGain, seasonWins: p.seasonWins })
  }
  const order = { upgrade: 0, stash: 1, stream: 2 } as const
  const ranked = [...best.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.kind !== 'stream' ? (b.seasonWins ?? 0) - (a.seasonWins ?? 0) || b.seasonGain - a.seasonGain : b.weekGain - a.weekGain))
  // Streams beyond what the budget allows this week are still listed, but marked by the screen.
  // Open means a seat HE can fill: with the swap made, is he in that day's lineup? A guard on a day only F is open
  // is not (2026-10-10: the first version counted any open seat).
  // Each kind gets its own room: a long list of season moves must not push this week's streams off the screen.
  const limit = opts.limit ?? 8
  const shown = (['upgrade', 'stash', 'stream'] as const).flatMap((k) => ranked.filter((p) => p.kind === k).slice(0, limit))
  for (const p of shown) {
    if (!p.playDays.length) continue
    const roster = [...myIds.filter((x) => x.id !== p.drop), { id: p.add, eligible: p.positions }]
    const wk = sideOutlook(ctx, null, roster, seats, allDays).week
    const seated = new Map(allDays.map((d, i) => [d, (wk.days[i]?.starting ?? []).includes(p.add)]))
    p.playDays = p.playDays.map((d) => ({ date: d.date, open: seated.get(d.date) ?? false }))
  }
  // Two moves together, from the best singles: different players added, different players dropped, the seats still
  // covered. Shown when the pair beats the best single move by a second move's worth (2026-10-19: the public league's
  // best was two moves, +1.7 wins together, and the list could only show them one at a time).
  const pairs: PairMove[] = []
  if (judged && tried.length > 1) {
    const best = Math.max(0, ...tried.map((t) => t.wins))
    const top = [...tried].sort((a, b) => b.wins - a.wins).slice(0, PAIR_POOL)
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j]
      if (a.add.id === b.add.id || a.drop.id === b.drop.id) continue
      const roster = [...myIds.filter((x) => x.id !== a.drop.id && x.id !== b.drop.id), a.add, b.add]
      if (!keepsSeatDepth(myIds, roster, seats)) continue
      const wins = seasonWins(roster) - baseWins
      if (wins < best + PAIR_MARGIN) continue
      const name = (id: string) => ctx.byId.get(id)?.name ?? id
      pairs.push({
        moves: [a, b].map((t) => ({ add: t.add.id, name: name(t.add.id), drop: t.drop.id, dropName: name(t.drop.id), waiver: waiverIds.has(t.add.id), seasonWins: t.wins })),
        seasonWins: wins, winBefore: base.win, winAfter: score(roster).win, confidence: null,
      })
    }
    pairs.sort((x, y) => y.seasonWins - x.seasonWins)
  }
  // How each move holds up: the players in it (added and dropped) under each what-if, the rest as projected.
  const check = (ids: string[], before: { id: string; eligible: string[] }[], after: { id: string; eligible: string[] }[], measure: 'season' | 'week'): Confidence => {
    const gains: number[] = []
    for (let i = 0; i < WHATIFS; i++) {
      ctx.whatif = new Map(ids.map((id) => [id, whatifFor(id, i)]))
      gains.push(measure === 'season' ? seasonWins(after) - seasonWins(before) : score(after).win - score(before).win)
    }
    ctx.whatif = null
    const sorted = [...gains].sort((a, b) => a - b)
    return { holds: gains.filter((g) => g > 0).length, of: WHATIFS, low: sorted[1], high: sorted[sorted.length - 2] }
  }
  const asAdd = (p: { add: string; positions: string[] }) => ({ id: p.add, eligible: p.positions })
  let checked = 0
  for (const p of shown) {
    const after = [...myIds.filter((x) => x.id !== p.drop), asAdd(p)]
    if (p.kind === 'stream') p.confidence = check([p.add, ...(p.drop ? [p.drop] : [])], myIds, after, 'week')
    else if (judged && checked++ < CHECKED_SEASON) p.confidence = check([p.add, ...(p.drop ? [p.drop] : [])], myIds, after, 'season')
  }
  const top = pairs.slice(0, 3)
  for (const pr of top) {
    const after = [...myIds.filter((x) => !pr.moves.some((m) => m.drop === x.id)), ...pr.moves.map((m) => ({ id: m.add, eligible: ctx.byId.get(m.add)?.positions ?? [] }))]
    pr.confidence = check(pr.moves.flatMap((m) => [m.add, m.drop]), myIds, after, 'season')
  }
  return { pickups: shown, pairs: top, ilBack }
}

function scoreWithAddFrom(ctx: Context, mySide: Parameters<typeof sideOutlook>[1], rest: { id: string; eligible: string[] }[],
  dropped: { id: string; eligible: string[] }, add: { id: string; eligible: string[] }, seats: string[], allDays: string[], addDays: string[],
  opp: ReturnType<typeof sideOutlook>['side'] | null, theirs: Parameters<typeof sideOutlook>[1]) {
  if (!opp) return { gain: 0, win: 0.5 }
  const first = addDays[0] ?? '9999-12-31'
  // Days before the add counts: the old roster. From then on: the new one.
  const before = allDays.filter((d) => d < first), after = allDays.filter((d) => d >= first)
  const a1 = sideOutlook(ctx, mySide, [...rest, dropped], seats, before).side
  const a2 = sideOutlook(ctx, null, [...rest, add], seats, after).side
  const side = { now: a1.now, rest: addBox(a1.rest, a2.rest), restVar: addBox(a1.restVar, a2.restVar) }
  if (ctx.league.scoring === 'categories') {
    const o = categoryWeek(side, opp)
    return { gain: o.expected, win: o.win, races: o.races.map((r) => ({ cat: r.cat, win: r.win + r.tie / 2 })) }
  }
  const o = pointsWeek(side, opp, ctx.league.points ?? {}, { mine: mySide?.points ?? null, theirs: theirs?.points ?? null })
  return { gain: o.mine - o.theirs, win: o.win, races: undefined as { cat: Cat; win: number }[] | undefined }
}

/**
 * The regular-season weeks left from a date: each week's days from then, and my opponent that week. The league's
 * schedule as far as it has been read; past that, Yahoo's weeks before the playoffs with this week's opponent
 * standing in, and then the measure is not `scheduled`.
 */
export function seasonLeft(snap: Snapshot, myTeamId: string, from: string, thisWeeks: string | null): { weeks: { week: number; days: string[]; opp: string | null }[]; scheduled: boolean } {
  const days = (s: string, e: string) => daysFrom(s, e, s > from ? s : from)
  const read = (snap.fixtures ?? []).filter((f) => f.end >= from).map((f) => {
    const pair = f.pairs.find((x) => x.includes(myTeamId))
    return { week: f.week, days: days(f.start, f.end), opp: pair ? (pair[0] === myTeamId ? pair[1] : pair[0]) : null }
  })
  const lastEnd = snap.fixtures?.length ? snap.fixtures[snap.fixtures.length - 1].end : null
  const playoffs = snap.settings?.playoffStartWeek ?? Infinity
  const rest = snap.weeks.filter(([n, s, e]) => n < playoffs && e >= from && (!lastEnd || s > lastEnd)).map(([n, s, e]) => ({ week: n, days: days(s, e), opp: thisWeeks }))
  return { weeks: [...read, ...rest], scheduled: rest.length === 0 && read.length > 0 }
}

function schedulePlays(ctx: Context, date: string, team: string): boolean {
  return (ctx.teamDates.get(team) ?? []).includes(date)
}

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })

export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

/**
 * The week's adds as a plan: a season upgrade first where it does not cost the week, then streams rolled across the
 * week (the second picked up after the first one's last game, dropping him), one add kept back for an injury when
 * there are three or more. Built from the pickups already scored; the steps are suggestions in order, not a script.
 */
export interface AddPlan {
  left: number
  steps: {
    when: string; add: string; drop: string | null; why: string
    /** This week's chance of winning before and after, where the move is made this week; and its season wins. */
    week: { before: number; after: number } | null
    season: number | null
  }[]
  reserve: number
}

/**
 * The week's adds as a plan. A season move that costs this week waits for Monday when that is worth more: its season
 * gain already counts this week's loss, so made after the week it keeps the rest and loses nothing now (2026-10-19:
 * the public plan took Tre Jones now, +0.49, over Miles Bridges, +0.74, because Bridges cost week 1 seven points;
 * on Monday he was worth about +0.81). A Monday move does not spend this week's adds.
 */
export function addPlan(picks: Pickup[], budget: Budget | null, today: string, weekEnd: string | null = null): AddPlan | null {
  const left = budget?.week ? Math.max(0, budget.week.max - budget.week.used)
    : budget?.season ? Math.max(0, budget.season.max - budget.season.used) : 4
  if (!left) return { left, steps: [], reserve: 0 }
  const reserve = left >= 3 ? 1 : 0
  let spend = left - reserve
  const steps: AddPlan['steps'] = []
  const used = new Set<string>()
  const dropped = new Set<string>()
  const cost = (p: Pickup) => Math.max(0, p.winBefore - p.winAfter)
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const monday = weekEnd ? addDays(weekEnd, 1) : null
  const ups = picks.filter((p) => p.kind === 'upgrade').map((p) => {
    const later = monday && p.seasonWins != null && cost(p) > 0.03
    // Now: the season gain as it stands, this week's loss included. Monday: the same, less that loss.
    return { p, later: !!later, value: p.seasonWins == null ? p.seasonGain / 1000 : later ? p.seasonWins + cost(p) : p.seasonWins }
  }).filter((x) => x.later || x.p.winAfter >= x.p.winBefore - 0.03).sort((a, b) => b.value - a.value)
  const dayWord = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  for (const { p, later, value } of ups) {
    if (dropped.has(p.drop ?? '') || used.has(p.add)) continue
    if (later) {
      steps.push({ when: `${dayWord(monday!)}, after this week`, add: p.name, drop: p.dropName, why: `${p.why}; +${value.toFixed(2)} wins made then, against +${p.seasonWins!.toFixed(2)} now, which costs this week ${pct(p.winBefore)} → ${pct(p.winAfter)}${p.waiver ? '' : ' (if he is still there)'}`, week: null, season: value })
    } else {
      if (!spend) continue
      steps.push({ when: p.waiver ? 'claim now (clears in a day)' : 'now', add: p.name, drop: p.dropName, why: p.why, week: { before: p.winBefore, after: p.winAfter }, season: p.seasonWins })
      spend--
    }
    used.add(p.add); if (p.drop) dropped.add(p.drop)
  }
  // Streams: the best first; then, while adds remain, one whose games all come after the last stream's last game.
  const streams = picks.filter((p) => p.kind === 'stream' && !used.has(p.add) && p.playDays.length).sort((a, b) => b.weekGain - a.weekGain)
  let last: Pickup | null = null
  for (const p of streams) {
    if (!spend) break
    if (last && p.playDays[0].date <= last.playDays.at(-1)!.date) continue
    if (!last && dropped.has(p.drop ?? '')) continue
    steps.push({
      when: last ? `after ${last.name}'s last game (${weekday(last.playDays.at(-1)!.date)})` : p.waiver ? 'claim now' : 'now',
      add: p.name, drop: last ? last.name : p.dropName,
      why: `plays ${p.playDays.map((d) => weekday(d.date)).join(', ')}, ${p.playDays.filter((d) => d.open).length} into empty spots`,
      week: last ? null : { before: p.winBefore, after: p.winAfter }, season: null,
    })
    last = p; spend--
  }
  return { left, steps, reserve }
}

/**
 * The season's category plan: where my roster wins, leans, is in play and has given up, against this league's
 * rosters (Power's edges); the category closest to becoming another strong one; and the free agents who would push
 * it without costing the strong ones. A 6-3 week needs a sixth category won more often than not.
 */
export interface CategoryPlan {
  strong: Cat[]; lean: Cat[]; swing: Cat[]; givenUp: Cat[]
  target: Cat | null
  targets: { id: string; name: string; team: string | null; positions: string[]; gain: number; costs: Cat[]; waiver: boolean }[]
}

export function categoryPlan(ctx: Context, snap: Snapshot, edges: Partial<Record<Cat, number>>, punts: Cat[]): CategoryPlan {
  const e = (c: Cat) => edges[c] ?? 0.5
  const strong = CATS.filter((c) => e(c) >= 0.6)
  const lean = CATS.filter((c) => e(c) >= 0.5 && e(c) < 0.6)
  const swing = CATS.filter((c) => e(c) >= 0.35 && e(c) < 0.5 && !punts.includes(c))
  const givenUp = CATS.filter((c) => !strong.includes(c) && !lean.includes(c) && !swing.includes(c))
  const target = [...lean, ...swing].sort((a, b) => e(b) - e(a))[0] ?? null
  if (!target) return { strong, lean, swing, givenUp, target, targets: [] }
  const rostered = new Set<string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) rostered.add(id) }
  const waivers = new Set(snap.waivers)
  const targets = ctx.world.players
    .filter((p) => p.projection && p.team && !rostered.has(p.id) && !ctx.world.never.has(p.id) && ctx.gamesLeft(p.id) >= 20)
    .map((p) => {
      const z = ctx.zOf(p.id)
      if (!z) return null
      const keep = strong.reduce((s, c) => s + z[c], 0)
      return { p, z, keep }
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.z[target] >= 0.5 && x.keep >= -0.5)
    .sort((a, b) => b.z[target] + 0.3 * b.keep - (a.z[target] + 0.3 * a.keep))
    .slice(0, 3)
    .map(({ p, z }) => ({
      id: p.id, name: p.name, team: p.team, positions: p.positions, gain: z[target],
      costs: strong.filter((c) => z[c] <= -0.4), waiver: !!p.yahoo?.yahooId && waivers.has(p.yahoo.yahooId),
    }))
  return { strong, lean, swing, givenUp, target, targets }
}
