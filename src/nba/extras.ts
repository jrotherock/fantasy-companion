/**
 * The season-long questions: how lucky the record is, how the teams compare,
 * how the playoff weeks look, and which trades help both sides.
 *
 * All four measure a roster by its typical week (strength.ts) and compare it
 * with every other roster in the league, which is what all-play does with real
 * weeks. That is the one yardstick that means the same thing in a trade, a
 * power ranking and a playoff plan.
 */
import type { NbaMatchup } from './yahooSeason.js'
import { catsOf } from './yahooSeason.js'
import { CATS, type Cat } from './value.js'
import { startingSeats } from './week.js'
import { catsVsLeague, pointsVsLeague, typicalWeek, type Member } from './strength.js'
import { member, rosterIds, teamWeeks, type Context, type Snapshot } from './inseason.js'
import { pointsOf } from './matchup.js'

// ── All-play ────────────────────────────────────────────────────────────────

export interface AllPlay {
  weeks: number
  /** Real record: weeks won, lost, tied. */
  record: { w: number; l: number; t: number }
  /** Against every team every week, as a share won (ties half). */
  allPlay: number
  /** Real share won less all-play share: positive is lucky. */
  luck: number
  /** Per week: my all-play share, and whether I won the real matchup. */
  byWeek: { week: number; share: number; result: 'W' | 'L' | 'T' | null }[]
  /** Every team's all-play share, to place mine. */
  table: { teamId: string; name: string; share: number; real: number }[]
}

/** Categories one team took from another in a finished week, from the two box lines. */
export function catsTaken(a: NbaMatchup['sides'][number], b: NbaMatchup['sides'][number], cats: Cat[] = CATS): { won: number; lost: number } {
  if (!a.box || !b.box) return { won: 0, lost: 0 }
  const ca = catsOf(a.box), cb = catsOf(b.box)
  let won = 0, lost = 0
  for (const c of cats) {
    const d = c === 'to' ? cb[c] - ca[c] : ca[c] - cb[c]
    if (d > 1e-9) won++
    else if (d < -1e-9) lost++
  }
  return { won, lost }
}

export function allPlay(past: Record<number, NbaMatchup[]>, myTeamId: string, scoring: 'points' | 'categories'): AllPlay | null {
  const weeks = Object.keys(past).map(Number).sort((a, b) => a - b)
    .filter((w) => past[w].length && past[w].every((m) => m.status === 'postevent') && !past[w].some((m) => m.playoffs))
  if (!weeks.length) return null
  const totals = new Map<string, { name: string; share: number; real: number; n: number }>()
  const byWeek: AllPlay['byWeek'] = []
  const record = { w: 0, l: 0, t: 0 }
  for (const w of weeks) {
    const sides = past[w].flatMap((m) => m.sides)
    for (const s of sides) {
      let got = 0
      const others = sides.filter((o) => o.id !== s.id)
      for (const o of others) {
        let r: number
        if (scoring === 'categories') { const t = catsTaken(s, o); r = t.won > t.lost ? 1 : t.won < t.lost ? 0 : 0.5 }
        else r = (s.points ?? 0) > (o.points ?? 0) ? 1 : (s.points ?? 0) < (o.points ?? 0) ? 0 : 0.5
        got += r
      }
      const share = others.length ? got / others.length : 0
      const m = past[w].find((x) => x.sides.some((y) => y.id === s.id))!
      const opp = m.sides.find((y) => y.id !== s.id)
      let real: number
      if (scoring === 'categories' && opp) { const t = catsTaken(s, opp); real = t.won > t.lost ? 1 : t.won < t.lost ? 0 : 0.5 }
      else real = opp ? ((s.points ?? 0) > (opp.points ?? 0) ? 1 : (s.points ?? 0) < (opp.points ?? 0) ? 0 : 0.5) : 0.5
      const cur = totals.get(s.id) ?? { name: s.name, share: 0, real: 0, n: 0 }
      cur.share += share; cur.real += real; cur.n++
      totals.set(s.id, cur)
      if (s.id === myTeamId) {
        byWeek.push({ week: w, share, result: real === 1 ? 'W' : real === 0 ? 'L' : 'T' })
        if (real === 1) record.w++; else if (real === 0) record.l++; else record.t++
      }
    }
  }
  const mine = totals.get(myTeamId)
  if (!mine) return null
  const table = [...totals.entries()].map(([teamId, t]) => ({ teamId, name: t.name, share: t.share / t.n, real: t.real / t.n }))
    .sort((a, b) => b.share - a.share)
  return { weeks: weeks.length, record, allPlay: mine.share / mine.n, luck: mine.real / mine.n - mine.share / mine.n, byWeek, table }
}

// ── Power: every roster's typical week against the league ──────────────────

export interface PowerRow {
  teamId: string
  name: string
  manager: string
  mine: boolean
  /** Expected categories a week against an average opponent, or the chance of beating one in points. */
  score: number
  /** Per category: chance of beating an average opponent. Categories only. */
  edges: Partial<Record<Cat, number>> | null
  rank: number
}

export function power(ctx: Context, snap: Snapshot): PowerRow[] {
  const tw = teamWeeks(ctx, snap)
  const rows: PowerRow[] = snap.rosters.map((r) => {
    const mine = tw.get(r.team.id)!.box.box
    const others = [...tw.entries()].filter(([id]) => id !== r.team.id).map(([, v]) => v.box.box)
    let score: number, edges: PowerRow['edges'] = null
    if (ctx.league.scoring === 'categories') {
      score = catsVsLeague(mine, others, ctx.world.noise)
      edges = Object.fromEntries(CATS.map((c) => [c, others.reduce((s, o) => s + catsVsLeague(mine, [o], ctx.world.noise, [c]), 0) / Math.max(1, others.length)]))
    } else score = pointsVsLeague(mine, others, ctx.league.points ?? {})
    return { teamId: r.team.id, name: r.team.name, manager: r.team.manager, mine: r.team.mine, score, edges, rank: 0 }
  }).sort((a, b) => b.score - a.score)
  rows.forEach((r, i) => (r.rank = i + 1))
  return rows
}

// ── Playoff weeks ──────────────────────────────────────────────────────────

export interface PlayoffPlan {
  weeks: number[]
  /** Games my players' teams play across the playoff weeks. */
  mine: { id: string; name: string; games: number }[]
  /** Total over my roster against the league's rosters. */
  total: number
  leagueAverage: number
  rank: number
  /** Free agents worth holding for those weeks: good, with more games than most. */
  targets: { id: string; name: string; team: string | null; games: number; worth: number }[]
  tradeDeadline: string | null
  daysToDeadline: number | null
}

export function playoffPlan(ctx: Context, snap: Snapshot, myTeamId: string): PlayoffPlan | null {
  const weeks = ctx.league.playoffWeeks
  if (!weeks.length || !snap.weeks.length) return null
  const ranges = snap.weeks.filter(([n]) => weeks.includes(n))
  if (!ranges.length) return null
  const gamesIn = (team: string | null) => (ctx.teamDates.get(team ?? '') ?? []).filter((d) => ranges.some(([, s, e]) => s <= d && d <= e)).length
  const rosterGames = (players: Snapshot['rosters'][number]['players']) =>
    rosterIds(ctx, players).map(({ id }) => ({ id, name: ctx.byId.get(id)?.name ?? id, games: gamesIn(ctx.byId.get(id)?.team ?? null) }))
  const all = snap.rosters.map((r) => ({ id: r.team.id, rows: rosterGames(r.players) }))
  const totals = all.map((t) => ({ id: t.id, total: t.rows.reduce((s, x) => s + x.games, 0) })).sort((a, b) => b.total - a.total)
  const mine = all.find((t) => t.id === myTeamId)
  if (!mine) return null
  const avgGames = (() => {
    const teams = new Set<string>()
    for (const g of ctx.world.schedule) { teams.add(g.home); teams.add(g.away) }
    const xs = [...teams].map((t) => gamesIn(t))
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  })()
  const owned = new Set<string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) owned.add(id) }
  const targets = ctx.world.players
    .filter((p) => p.projection && p.team && !owned.has(p.id) && !ctx.world.never.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, team: p.team, games: gamesIn(p.team), worth: ctx.worth(p.id) }))
    .filter((p) => p.games > avgGames)
    .sort((a, b) => b.worth - a.worth)
    .slice(0, 6)
  const deadline = snap.settings?.tradeEnd ?? null
  const days = deadline ? Math.round((Date.parse(deadline + 'T12:00:00Z') - Date.parse(ctx.world.today + 'T12:00:00Z')) / 86400000) : null
  const t = totals.find((x) => x.id === myTeamId)!
  return {
    weeks, mine: mine.rows.sort((a, b) => b.games - a.games), total: t.total,
    leagueAverage: totals.reduce((s, x) => s + x.total, 0) / totals.length,
    rank: totals.findIndex((x) => x.id === myTeamId) + 1,
    targets, tradeDeadline: deadline, daysToDeadline: days,
  }
}

// ── Trades ─────────────────────────────────────────────────────────────────

export interface TradeIdea {
  teamId: string
  teamName: string
  manager: string
  give: { id: string; name: string }[]
  get: { id: string; name: string }[]
  /** Change in expected categories a week (or win chance, in points) for me, and for them. */
  me: number
  them: number
  why: string
}

/**
 * Trades that help me and do not hurt them much: every one-for-one, and two of
 * mine for one of theirs (the roster spot that frees is filled from the wire at
 * the free-agent line). Ranked by my gain where theirs is not a clear loss — a
 * trade the other side would refuse is not an idea.
 */
export function tradeIdeas(ctx: Context, snap: Snapshot, myTeamId: string, limit = 8): TradeIdea[] {
  const deadline = snap.settings?.tradeEnd
  if (deadline && deadline < ctx.world.today) return []
  const seats = startingSeats(ctx.league.roster).length
  const tw = teamWeeks(ctx, snap)
  const mine = tw.get(myTeamId)
  if (!mine) return []
  const cats = ctx.league.scoring === 'categories'
  const measure = (box: ReturnType<typeof typicalWeek>['box'], others: ReturnType<typeof typicalWeek>['box'][]) =>
    cats ? catsVsLeague(box, others, ctx.world.noise) : pointsVsLeague(box, others, ctx.league.points ?? {})
  const boxes = (swap: Map<string, ReturnType<typeof typicalWeek>['box']>) =>
    [...tw.entries()].map(([id, v]) => [id, swap.get(id) ?? v.box.box] as const)
  const scoreOf = (teamId: string, swap: Map<string, ReturnType<typeof typicalWeek>['box']>) => {
    const all = boxes(swap)
    const me = all.find(([id]) => id === teamId)![1]
    return measure(me, all.filter(([id]) => id !== teamId).map(([, b]) => b))
  }
  const none = new Map()
  const baseMe = scoreOf(myTeamId, none)
  // A free agent at the line, to fill the spot a two-for-one frees.
  const owned = new Set<string>()
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) owned.add(id) }
  const fa = ctx.world.players.filter((p) => p.projection && p.team && !owned.has(p.id) && !ctx.world.never.has(p.id))
    .sort((a, b) => ctx.worth(b.id) - ctx.worth(a.id))[8]
  const filler: Member | null = fa ? member(ctx, fa.id) : null

  const ideas: TradeIdea[] = []
  const name = (id: string) => ctx.byId.get(id)?.name ?? id
  for (const [teamId, them] of tw) {
    if (teamId === myTeamId) continue
    const baseThem = scoreOf(teamId, none)
    const team = snap.rosters.find((r) => r.team.id === teamId)!.team
    const theirs = them.members.filter((m) => !ctx.world.never.has(m.id))
    const tryTrade = (give: Member[], get: Member[]) => {
      const gi = new Set(give.map((m) => m.id)), ge = new Set(get.map((m) => m.id))
      const myAfter = [...mine.members.filter((m) => !gi.has(m.id)), ...get]
      let theirAfter = [...them.members.filter((m) => !ge.has(m.id)), ...give]
      // Rosters are full: the side that takes more players cuts its weakest, the other fills from the wire.
      if (give.length > get.length) {
        if (filler) myAfter.push(filler)
        const cut = [...theirAfter].sort((a, b) => a.worth - b.worth).slice(0, give.length - get.length).map((m) => m.id)
        theirAfter = theirAfter.filter((m) => !cut.includes(m.id))
      }
      const swap = new Map([[myTeamId, typicalWeek(myAfter, seats).box], [teamId, typicalWeek(theirAfter, seats).box]])
      const me = scoreOf(myTeamId, swap) - baseMe
      const th = scoreOf(teamId, swap) - baseThem
      const bar = cats ? 0.08 : 0.01
      if (me > bar && th > -bar / 2) {
        ideas.push({
          teamId, teamName: team.name, manager: team.manager,
          give: give.map((m) => ({ id: m.id, name: name(m.id) })), get: get.map((m) => ({ id: m.id, name: name(m.id) })),
          me, them: th,
          why: cats
            ? `+${me.toFixed(2)} categories a week for you; ${th >= 0 ? `+${th.toFixed(2)}` : th.toFixed(2)} for them`
            : `Your chance of beating an average team: +${(me * 100).toFixed(0)}%; theirs ${th >= 0 ? '+' : ''}${(th * 100).toFixed(0)}%`,
        })
      }
    }
    for (const g of mine.members) for (const r of theirs) tryTrade([g], [r])
    // Two of mine for one of theirs: consolidating depth into a better player.
    const myDepth = [...mine.members].sort((a, b) => a.worth - b.worth).slice(0, 7)
    const theirBest = [...theirs].sort((a, b) => b.worth - a.worth).slice(0, 5)
    for (let i = 0; i < myDepth.length; i++) for (let j = i + 1; j < myDepth.length; j++) for (const r of theirBest) tryTrade([myDepth[i], myDepth[j]], [r])
  }
  // One idea per player received, the best for me among those they would not mind.
  const best = new Map<string, TradeIdea>()
  for (const t of ideas.sort((a, b) => b.me + Math.min(0, b.them) - (a.me + Math.min(0, a.them)))) {
    const key = t.get.map((g) => g.id).join('+')
    if (!best.has(key)) best.set(key, t)
  }
  return [...best.values()].slice(0, limit)
}

/** Points a typical week scores, for the screen's numbers. */
export const weeklyPoints = (ctx: Context, box: ReturnType<typeof typicalWeek>['box']) => pointsOf(box, ctx.league.points ?? {})
