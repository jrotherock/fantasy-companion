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
import { CATS, type Cat } from './value.js'
import { addBox } from './yahooSeason.js'
import { designation } from './outlook.js'

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
  alternatives: { drop: string; dropName: string; weekGain: number; winAfter: number; seasonGain: number }[]
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
  // Nobody who will not play enough to matter: a man out for the season is worth nought, which can outrank a weak roster's tail.
  const pool = ctx.world.players.filter((p) => p.projection && p.team && !rostered.has(p.id) && !ctx.world.never.has(p.id) && ctx.gamesLeft(p.id) >= MIN_GAMES_LEFT)
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
  const base = score(myIds)
  // My open seats each day as the roster stands: the days a pickup's games count without benching anyone.
  const openOn = new Map<string, number>()
  if (allDays.length) {
    const wk0 = sideOutlook(ctx, mySide, myIds, seats, allDays).week
    allDays.forEach((d, i) => openOn.set(d, Math.max(0, seats.length - (wk0.days[i]?.starting.length ?? 0))))
  }

  // Who could go: the weakest for the season, not hurt long-term (they belong on IL instead).
  const drops = myIds
    .map((x) => ({ ...x, season: season(x.id) }))
    .sort((a, b) => a.season - b.season)
    .slice(0, 5)
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
  const forSeason = byWorth.slice(0, 25)
  const forWeek = [...pool].sort((a, b) => worth(b.id) * weekGames(b.id) - worth(a.id) * weekGames(a.id)).slice(0, 25)
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
  for (const c of cands) {
    for (const d of drops) {
      const swapped = myIds.filter((x) => x.id !== d.id)
      // The dropped player still plays today; the add only from his first day.
      const add = { id: c.id, eligible: c.positions }
      if (!keepsSeatDepth(myIds, [...swapped, add], seats)) continue
      const after = scoreWithAddFrom(ctx, mySide, swapped, d, add, seats, allDays, daysFor(c.id), opp, theirs)
      const seasonGain = season(c.id) - d.season
      const weekGain = after.gain - base.gain
      // An upgrade has to be better per game by a margin worth an add, over the games he has left.
      const upgrade = seasonGain > UPGRADE_PER_GAME[ctx.league.scoring] * Math.max(10, ctx.gamesLeft(c.id))
      const stream = !upgrade && weekGain > (ctx.league.scoring === 'categories' ? 0.15 : 8) && seasonGain > -40
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
        waiver: waiverIds.has(c.id),
        why: stash
          ? `Out now; better than ${ctx.byId.get(d.id)?.name} once back, for the rest of the season`
          : upgrade
          ? `Better than ${ctx.byId.get(d.id)?.name} for the rest of the season`
          : ctx.league.scoring === 'categories'
            ? `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(2)} categories expected`
            : `${starts} game${starts === 1 ? '' : 's'} this week: +${weekGain.toFixed(0)} points expected`,
      })
    }
  }
  // One line per player added: his best drop, the other drops he beats as alternatives.
  const rank = (x: Pickup) => (x.kind !== 'stream' ? 1000 + x.seasonGain : x.weekGain * 100 + x.seasonGain / 10)
  const best = new Map<string, Pickup>()
  for (const p of [...out].sort((a, b) => rank(b) - rank(a))) {
    const cur = best.get(p.add)
    if (!cur) { best.set(p.add, p); continue }
    if (cur.alternatives.length < 3) cur.alternatives.push({ drop: p.drop!, dropName: p.dropName!, weekGain: p.weekGain, winAfter: p.winAfter, seasonGain: p.seasonGain })
  }
  const order = { upgrade: 0, stash: 1, stream: 2 } as const
  const ranked = [...best.values()].sort((a, b) => order[a.kind] - order[b.kind] || (a.kind !== 'stream' ? b.seasonGain - a.seasonGain : b.weekGain - a.weekGain))
  // Streams beyond what the budget allows this week are still listed, but marked by the screen.
  // Open means a seat HE can fill: with the swap made, is he in that day's lineup? A guard on a day only F is open
  // is not (2026-10-10: the first version counted any open seat).
  const shown = ranked.slice(0, opts.limit ?? 8)
  for (const p of shown) {
    if (!p.playDays.length) continue
    const roster = [...myIds.filter((x) => x.id !== p.drop), { id: p.add, eligible: p.positions }]
    const wk = sideOutlook(ctx, null, roster, seats, allDays).week
    const seated = new Map(allDays.map((d, i) => [d, (wk.days[i]?.starting ?? []).includes(p.add)]))
    p.playDays = p.playDays.map((d) => ({ date: d.date, open: seated.get(d.date) ?? false }))
  }
  return shown
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

function schedulePlays(ctx: Context, date: string, team: string): boolean {
  return (ctx.teamDates.get(team) ?? []).includes(date)
}

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
  steps: { when: string; add: string; drop: string | null; why: string }[]
  reserve: number
}

export function addPlan(picks: Pickup[], budget: Budget | null, today: string): AddPlan | null {
  const left = budget?.week ? Math.max(0, budget.week.max - budget.week.used)
    : budget?.season ? Math.max(0, budget.season.max - budget.season.used) : 4
  if (!left) return { left, steps: [], reserve: 0 }
  const reserve = left >= 3 ? 1 : 0
  let spend = left - reserve
  const steps: AddPlan['steps'] = []
  const used = new Set<string>()
  const dropped = new Set<string>()
  const ups = picks.filter((p) => p.kind === 'upgrade' && p.winAfter >= p.winBefore - 0.03)
  for (const p of ups) {
    if (!spend || dropped.has(p.drop ?? '')) continue
    steps.push({ when: p.waiver ? 'claim now (clears in a day)' : 'now', add: p.name, drop: p.dropName, why: `${p.why}; this week ${Math.round(p.winBefore * 100)}% → ${Math.round(p.winAfter * 100)}%` })
    used.add(p.add); if (p.drop) dropped.add(p.drop); spend--
  }
  // Streams: the best first; then, while adds remain, one whose games all come after the last stream's last game.
  const streams = picks.filter((p) => p.kind === 'stream' && !used.has(p.add) && p.playDays.length).sort((a, b) => b.weekGain - a.weekGain)
  let last: Pickup | null = null
  for (const p of streams) {
    if (!spend) break
    if (last && p.playDays[0].date <= last.playDays.at(-1)!.date) continue
    if (!last && dropped.has(p.drop ?? '')) continue
    const dayWord = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })
    steps.push({
      when: last ? `after ${last.name}'s last game (${dayWord(last.playDays.at(-1)!.date)})` : p.waiver ? 'claim now' : 'now',
      add: p.name, drop: last ? last.name : p.dropName,
      why: `plays ${p.playDays.map((d) => dayWord(d.date)).join(', ')}, ${p.playDays.filter((d) => d.open).length} into empty spots`,
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
