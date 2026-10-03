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
import { categoryWeek, pointsWeek } from './matchup.js'
import { rosterIds, sideOutlook, weekOf, type Context, type Snapshot } from './inseason.js'
import type { Cat } from './value.js'
import { addBox } from './yahooSeason.js'

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
  kind: 'upgrade' | 'stream'
  /** Expected categories (or win chance, in points) this week, gained by the move. */
  weekGain: number
  /** The week's chance of winning, before and after. */
  winBefore: number
  winAfter: number
  /** Value over the rest of the season, gained (negative: a stream that costs a little). */
  seasonGain: number
  /** Games he plays in seats this week, from the day he can be added. */
  startsThisWeek: number
  waiver: boolean
  why: string
}

/**
 * The best pickups, from a pool of players nobody rosters. `punts` are
 * categories my roster has given up, which no pickup should chase.
 */
export function pickups(ctx: Context, snap: Snapshot, myTeamId: string, opts: { punts?: Cat[]; limit?: number } = {}): Pickup[] {
  const { today } = ctx.world
  const mine = snap.rosters.find((r) => r.team.id === myTeamId)
  if (!mine) return []
  const rostered = new Set<string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) rostered.add(id) }
  const waivers = new Set(snap.waivers)
  const waiverIds = new Set<string>()
  for (const p of ctx.world.players) if (p.yahoo?.yahooId && waivers.has(p.yahoo.yahooId)) waiverIds.add(p.id)

  const punts = opts.punts ?? []
  const worth = (id: string) => ctx.worth(id, punts)
  // Rest-of-season value: per-game worth above the free-agent line, times games left.
  const pool = ctx.world.players.filter((p) => p.projection && p.team && !rostered.has(p.id) && !ctx.world.never.has(p.id))
  const byWorth = [...pool].sort((a, b) => worth(b.id) - worth(a.id))
  const line = worth(byWorth[Math.min(10, byWorth.length - 1)]?.id ?? '') || 0
  const season = (id: string) => (worth(id) - line) * ctx.gamesLeft(id)

  const myIds = rosterIds(ctx, mine.players)
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

  const score = (ids: { id: string; eligible: string[] }[]) => {
    if (!opp) return { gain: 0, win: 0.5 }
    const a = sideOutlook(ctx, mySide, ids, seats, allDays).side
    if (ctx.league.scoring === 'categories') {
      const o = categoryWeek(a, opp)
      return { gain: o.expected, win: o.win }
    }
    const o = pointsWeek(a, opp, ctx.league.points ?? {}, { mine: mySide?.points ?? null, theirs: theirs?.points ?? null })
    return { gain: o.mine - o.theirs, win: o.win }
  }
  const base = score(myIds)

  // Who could go: the weakest for the season, not hurt long-term (they belong on IL instead).
  const drops = myIds
    .map((x) => ({ ...x, season: season(x.id) }))
    .sort((a, b) => a.season - b.season)
    .slice(0, 3)

  // Candidates: the best for the season, and the best for this week's games.
  const weekGames = (id: string) => daysFor(id).filter((d) => {
    const t = ctx.byId.get(id)?.team
    return !!t && schedulePlays(ctx, d, t)
  }).length
  const forSeason = byWorth.slice(0, 25)
  const forWeek = [...pool].sort((a, b) => worth(b.id) * weekGames(b.id) - worth(a.id) * weekGames(a.id)).slice(0, 25)
  const cands = [...new Map([...forSeason, ...forWeek].map((p) => [p.id, p])).values()]

  const out: Pickup[] = []
  for (const c of cands) {
    for (const d of drops) {
      const swapped = myIds.filter((x) => x.id !== d.id)
      // The dropped player still plays today; the add only from his first day.
      const add = { id: c.id, eligible: c.positions }
      const after = scoreWithAddFrom(ctx, mySide, swapped, d, add, seats, allDays, daysFor(c.id), opp, theirs)
      const seasonGain = season(c.id) - d.season
      const weekGain = after.gain - base.gain
      // An upgrade has to be better per game by a margin worth an add, over the games he has left.
      const upgrade = seasonGain > UPGRADE_PER_GAME[ctx.league.scoring] * Math.max(10, ctx.gamesLeft(c.id))
      const stream = !upgrade && weekGain > (ctx.league.scoring === 'categories' ? 0.15 : 8) && seasonGain > -40
      if (!upgrade && !stream) continue
      const p = ctx.byId.get(c.id)!
      const starts = weekGames(c.id)
      out.push({
        add: c.id, name: p.name, team: p.team, positions: p.positions,
        drop: d.id, dropName: ctx.byId.get(d.id)?.name ?? d.id,
        kind: upgrade ? 'upgrade' : 'stream',
        weekGain, winBefore: base.win, winAfter: after.win, seasonGain, startsThisWeek: starts,
        waiver: waiverIds.has(c.id),
        why: upgrade
          ? `Better than ${ctx.byId.get(d.id)?.name} for the rest of the season`
          : ctx.league.scoring === 'categories'
            ? `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(2)} categories expected`
            : `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(0)} points expected`,
      })
    }
  }
  // One line per player added: his best drop.
  const best = new Map<string, Pickup>()
  for (const p of out) {
    const key = p.add
    const cur = best.get(key)
    const rank = (x: Pickup) => (x.kind === 'upgrade' ? 1000 + x.seasonGain : x.weekGain * 100 + x.seasonGain / 10)
    if (!cur || rank(p) > rank(cur)) best.set(key, p)
  }
  const ranked = [...best.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'upgrade' ? -1 : 1) || (b.kind === 'upgrade' ? b.seasonGain - a.seasonGain : b.weekGain - a.weekGain))
  // Streams beyond what the budget allows this week are still listed, but marked by the screen.
  return ranked.slice(0, opts.limit ?? 8)
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
    return { gain: o.expected, win: o.win }
  }
  const o = pointsWeek(side, opp, ctx.league.points ?? {}, { mine: mySide?.points ?? null, theirs: theirs?.points ?? null })
  return { gain: o.mine - o.theirs, win: o.win }
}

function schedulePlays(ctx: Context, date: string, team: string): boolean {
  return (ctx.teamDates.get(team) ?? []).includes(date)
}

export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}
