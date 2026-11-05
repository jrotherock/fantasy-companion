import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NbaPlayer, Game } from './types.js'
import { Context, rosterIds, weekValue, type LineupRow, type SeasonLeague, type Snapshot, type World } from './inseason.js'
import { startSitView } from './seasonView.js'
import { CAT_GAP_SD, CAT_SD, FP_GAP_SD, startSit, surenessOf } from './startsit.js'
import { emptyBox, type Box } from './yahooSeason.js'

const players: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const schedule: Game[] = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games
const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
const sdWeekly = Object.fromEntries(Object.entries<any>(JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).raw).map(([k, v]) => [k, v.sdWeekly])) as any
const world = (today: string): World => ({ players, logs: [], dayProj: new Map(), injuries: [], returns: new Map(), schedule, noise: { sdWeekly }, never: new Set(), now: Date.parse(today + 'T16:00:00Z'), today })
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y }
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

/** A league from a captured snapshot (scripts/nba-season-analysis), week 1 against its real opponent. */
function league(dir: string, id: string, me: string, today: string) {
  const base = leagues.find((l: any) => l.id === id)
  const d = JSON.parse(readFileSync(`scripts/nba-season-analysis/${dir}/sched.json`, 'utf8'))
  const byY = new Map(players.filter((p) => p.yahoo).map((p) => [p.yahoo!.yahooId, p]))
  const meta = (tid: string) => ({ id: tid, key: `t.${tid}`, name: `Team ${tid}`, manager: null, mine: tid === me, addsThisWeek: 0 }) as any
  const yp = (p: NbaPlayer, slot: string) => ({ key: `p.${p.yahoo!.yahooId}`, yahooId: p.yahoo!.yahooId, name: p.name, display: p.name, team: p.team, primary: p.positions[0], eligible: p.positions, slot, status: null, injury: null }) as any
  const rosters = d.rosters.split('\n').map((line: string) => {
    const [tid, , list] = line.split('~')
    return { team: meta(tid), players: list.split(',').map((y: string) => ({ y: y.replace('i', ''), il: y.endsWith('i') })).filter((x: any) => byY.has(x.y)).map((x: any) => yp(byY.get(x.y)!, x.il ? 'IL' : 'BN')) }
  })
  const [w, s, e, pairs] = d.weeks.split('|')[0].split(':')
  const opp = pairs.split(',').map((x: string) => x.split('-')).find((p: string[]) => p.includes(me))!.find((t: string) => t !== me)
  const side = (tid: string) => ({ ...meta(tid), box: emptyBox(), points: 0, projected: null, games: null })
  const snap = {
    at: Date.parse(today + 'T16:00:00Z'), settings: null, weeks: [[+w, s, e]], rosters, mineToday: null,
    scoreboard: [{ week: +w, start: s, end: e, status: 'midevent', playoffs: false, consolation: false, winnerTeamId: null, sides: [side(me), side(opp)], leaders: {} }],
    past: {}, standings: [], waivers: [], transactions: [],
  } as unknown as Snapshot
  const lg = { ...base, myTeamId: me } as SeasonLeague & { myTeamId: string }
  const wd = world(today)
  const ctx = new Context(lg, wd)
  const mine = rosterIds(ctx, rosters.find((r: any) => r.team.id === me)!.players).map((x) => x.id)
  return { lg, snap, w: wd, ctx, mine, start: s as string, end: e as string }
}
const playsOn = (ctx: Context, id: string, date: string) => schedule.some((g) => g.date === date && (g.home === ctx.byId.get(id)!.team || g.away === ctx.byId.get(id)!.team))
/** The day of the week, from today, when most of mine play. */
const busiest = (ctx: Context, mine: string[], from: string, to: string) => [...new Set(schedule.filter((g) => g.date >= from && g.date <= to).map((g) => g.date))]
  .sort((x, y) => mine.filter((id) => playsOn(ctx, id, y)).length - mine.filter((id) => playsOn(ctx, id, x)).length || x.localeCompare(y))[0]

test('start/sit, points: the one with more fantasy points tonight, and how sure from the backtested spread', () => {
  const { lg, snap, w, ctx, mine, end } = league('2026-10-19-harker', 'nba-harker', '3', '2026-10-21')
  const date = busiest(ctx, mine, '2026-10-21', end)
  const on = mine.filter((id) => playsOn(ctx, id, date))
  assert.ok(on.length >= 3, 'three of mine play')
  const fp = (id: string) => { const o = ctx.outlook(id, date)!; return Object.entries(lg.points!).reduce((t, [k, x]) => t + (x ?? 0) * (o.box[k as keyof Box] ?? 0), 0) * ctx.play(id, date) }
  const [a, b] = [on[0], on[1]]
  const s = startSit(ctx, snap, '3', date, a, b)
  const [hi, lo] = fp(a) >= fp(b) ? [a, b] : [b, a]
  assert.equal(s.basis, 'points')
  assert.equal(s.pick, hi)
  assert.ok(Math.abs(s.chance - Phi((fp(hi) - fp(lo)) / FP_GAP_SD)) < 1e-9)
  assert.equal(s.sureness, surenessOf(s.chance))
  assert.ok(s.headline.includes(ctx.byId.get(hi)!.name))
  // The same call either way round.
  const r = startSit(ctx, snap, '3', date, b, a)
  assert.equal(r.pick, s.pick); assert.ok(Math.abs(r.chance - s.chance) < 1e-12)
  // What would turn it: the pick's minutes down to where his line is worth the other's.
  const f = fp(lo) / fp(hi), min = ctx.outlook(hi, date)!.min!
  if (s.sureness === 'coin flip') assert.equal(s.flip, null, 'a coin flip names nothing')
  else if (f >= 0.6 && f < 1 && ctx.play(hi, date) >= 0.9) assert.equal(s.flip, `Would flip if ${ctx.byId.get(hi)!.name} plays under ${Math.floor(min * f)} minutes`)
  // Every pair that day: a coin flip names nothing that would turn it; a clearer call often does.
  const all = on.flatMap((x, i) => on.slice(i + 1).map((y) => startSit(ctx, snap, '3', date, x, y)))
  const flips = all.filter((x) => x.sureness === 'coin flip')
  assert.ok(flips.length > 0, 'some pair is a coin flip')
  for (const x of flips) assert.equal(x.flip, null, x.headline)
  // One without a game that day: the other, for certain.
  const idle = mine.find((id) => !playsOn(ctx, id, date))!
  const c = startSit(ctx, snap, '3', date, idle, a)
  assert.equal(c.pick, a); assert.equal(c.sureness, 'clear'); assert.ok(c.headline.endsWith('has no game'))
  // Through the view: only players of mine.
  const other = players.find((p) => p.projection && !mine.includes(p.id))!.id
  assert.ok('error' in startSitView(lg, snap, w, a, other, date))
  assert.equal((startSitView(lg, snap, w, a, b, date) as any).pick, s.pick)
})

test("start/sit, categories: a line is worth what it does for this week, so an edge in a race already decided counts for little", () => {
  const { snap, ctx, mine, end } = league('2026-10-19-hoops', 'nba-hoops', '4', '2026-10-21')
  const date = busiest(ctx, mine, '2026-10-21', end)
  const on = mine.filter((id) => playsOn(ctx, id, date) && ctx.play(id, date) > 0.9)
  const reb = (id: string) => ctx.outlook(id, date)!.box.reb
  const big = [...on].sort((x, y) => reb(y) - reb(x))[0], small = [...on].sort((x, y) => reb(x) - reb(y))[0]
  assert.ok(reb(big) - reb(small) >= 4, 'a rebounder and a guard')
  const s = startSit(ctx, snap, '4', date, big, small)
  assert.equal(s.basis, 'week')
  // Its worth is the lineup's own week value, and how sure is the spread scaled by how much the week moves.
  const week = weekValue(ctx, snap, '4', date)!
  let n = 0
  const row = (line: Box, play: number) => ({ id: `t${n++}`, game: { vs: '' }, tonight: line, play }) as unknown as LineupRow
  const v = (id: string) => week(row(ctx.outlook(id, date)!.box, ctx.play(id, date)))
  assert.ok(Math.abs(s.a.value - v(big)) < 1e-9 && Math.abs(s.b.value - v(small)) < 1e-9)
  const unit = (c: string) => { const b = emptyBox(); if (c === 'fg') b.fgm = CAT_SD.fg; else if (c === 'ft') b.ftm = CAT_SD.ft; else if (c === 'to') b.to = -CAT_SD.to; else (b as any)[c] = (CAT_SD as any)[c]; return b }
  const strength = Math.sqrt(['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'].reduce((t, c) => t + week(row(unit(c), 1)) ** 2, 0) / 9)
  assert.ok(Math.abs(s.chance - Phi(Math.abs(v(big) - v(small)) / (CAT_GAP_SD * strength))) < 1e-9)
  // Rebounds won already (a 400-rebound lead banked): the rebounder's edge there stops counting.
  const won = { ...snap, scoreboard: snap.scoreboard.map((m) => ({ ...m, sides: m.sides.map((x) => (x.id === '4' ? { ...x, box: { ...x.box, reb: 400 } } : x)) })) } as Snapshot
  const ctx2 = new Context(ctx.league, ctx.world)
  const t = startSit(ctx2, won, '4', date, big, small)
  const week2 = weekValue(ctx2, won, '4', date)!
  const wReb = week(row(unit('reb'), 1)), wReb2 = week2(row(unit('reb'), 1))
  assert.ok(wReb > 0.2, `rebounds count while the race is open: ${wReb}`)
  assert.ok(wReb2 < wReb * 0.1, `and barely once it is won: ${wReb} → ${wReb2}`)
  // So the rebounder loses about what his rebound edge was worth.
  const edge = wReb * (reb(big) * ctx.play(big, date) - reb(small) * ctx.play(small, date)) / CAT_SD.reb
  const shrink = (s.a.value - s.b.value) - (t.a.value - t.b.value)
  assert.ok(shrink > edge * 0.6, `rebounder's edge shrinks by ${shrink.toFixed(2)}, his rebounds were worth ${edge.toFixed(2)}`)
  if (t.pick === small) assert.ok(t.reasons.some((x) => x.includes('rebounds') && x.includes('barely counts')), t.reasons.join(' | '))
})

test('start/sit: how sure, in words, from the backtested chance', () => {
  assert.equal(surenessOf(0.52), 'coin flip')
  assert.equal(surenessOf(0.6), 'lean')
  assert.equal(surenessOf(0.7), 'fairly sure')
  assert.equal(surenessOf(0.85), 'confident')
  assert.equal(surenessOf(1), 'clear')
})
