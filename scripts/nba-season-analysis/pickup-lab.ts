/**
 * Every free agent against every player on my roster, judged the way the app's pickups now are: matchups expected
 * won over each regular-season week left, each against that week's real opponent, nightly lineups, each player at
 * his own season rate, with this league's own view of players (data/preferences/nba.json `adjust`) in place.
 * Week 1 is the first week's chance of winning, before and after.
 *
 *   npx tsx scripts/nba-season-analysis/pickup-lab.ts <snapshot dir> <league id> <my team id> <today> [names, comma-separated]
 *
 * The snapshot's sched.json: `weeks` ("n:start:end:a-b,c-d|..."), `rosters` ("tid~name~yahooId,...", i = IL) and
 * `fa` (Yahoo's available players, Yahoo ids).
 *
 * MOVES="Drop>Add;Drop>Add" (names) makes those moves first, then scores the rest from there: two moves together.
 */
import { readFileSync, existsSync } from 'node:fs'
import { Context, sideOutlook, type World } from '../../src/nba/inseason.js'
import { categoryWeek, pointsWeek } from '../../src/nba/matchup.js'
import { daysFrom, startingSeats } from '../../src/nba/week.js'
import { addDays } from '../../src/nba/adds.js'
import { applyAdjustments, resolvePreferences } from '../../src/nba/preferences.js'
import { NameIndex } from '../../src/nba/join.js'

const [S, LEAGUE, ME, TODAY, NAMED = ''] = process.argv.slice(2)
const raw = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const prefs = existsSync('data/preferences/nba.json') ? JSON.parse(readFileSync('data/preferences/nba.json', 'utf8')) : null
const index = new NameIndex(raw.map((p) => ({ id: p.id, name: p.name, team: p.team })))
// SCALE="Name:0.8;Name:1.1" scales a player's per-game counting stats (a minutes view: 22 of 29 minutes is 0.76).
const scale = new Map((process.env.SCALE ?? '').split(';').filter(Boolean).map((x) => { const [n, f] = x.split(':'); return [n, Number(f)] as const }))
// PUNT="ast,ft" plays those categories as given up: every player the same in them, so no move can win or lose them.
const punt = (process.env.PUNT ?? '').split(',').filter(Boolean)
const players = applyAdjustments(raw, resolvePreferences(prefs, LEAGUE, index).adjust).map((p: any) => {
  if (punt.length && p.projection) {
    const pg = { ...p.projection.perGame }, sh = { ...p.projection.shooting }
    for (const c of punt) { if (c === 'fg') sh.fgPct = 0.47; else if (c === 'ft') sh.ftPct = 0.78; else pg[c] = 1 }
    p = { ...p, projection: { ...p.projection, perGame: pg, shooting: sh } }
  }
  const f = scale.get(p.name)
  if (!f || !p.projection) return p
  const pg = Object.fromEntries(Object.entries(p.projection.perGame).map(([k, v]) => [k, typeof v === 'number' ? v * f : v]))
  return { ...p, projection: { ...p.projection, perGame: pg } }
})
const schedule = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8'))
const sdWeekly = Object.fromEntries(Object.entries(noise.raw).map(([k, v]: [string, any]) => [k, v.sdWeekly])) as any
const row = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === LEAGUE)
const league = { ...row, adds: row.adds ?? { perWeek: null, season: null }, playoffWeeks: row.playoffWeeks ?? [] }
const world: World = { players, logs: [], dayProj: new Map(), injuries: [], returns: new Map(), schedule, noise: { sdWeekly }, never: new Set(), now: Date.parse(TODAY + 'T16:00:00Z'), today: TODAY }
const ctx = new Context(league, world)
const seats = startingSeats(league.roster)
const d = JSON.parse(readFileSync(`${S}/sched.json`, 'utf8'))
const byY = new Map(players.filter((p: any) => p.yahoo).map((p: any) => [p.yahoo.yahooId, p]))
const man = (y: string) => { const p: any = byY.get(y); return p ? { id: p.id, eligible: [...(p.yahoo?.positions ?? p.positions), 'Util'] } : null }
const teams = new Map<string, { name: string; men: { id: string; eligible: string[] }[] }>()
for (const line of d.rosters.split('\n')) {
  const [tid, name, list] = line.split('~')
  teams.set(tid, { name, men: list.split(',').filter((y: string) => !y.endsWith('i')).map(man).filter(Boolean) as any })
}
const tomorrow = addDays(TODAY, 1)
const weeks = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); return { w: +w, a, b, pairs: pairs.split(',').map((x: string) => x.split('-')) } })
  .filter((w: any) => w.b >= tomorrow)
  .map((w: any) => { const p = w.pairs.find((x: string[]) => x.includes(ME)); const opp = p[0] === ME ? p[1] : p[0]; const days = daysFrom(w.a, w.b, w.a > tomorrow ? w.a : tomorrow); return { ...w, opp, days, side: sideOutlook(ctx, null, teams.get(opp)!.men, seats, days).side } })
const weekWin = (men: any[], w: any) => {
  const a = sideOutlook(ctx, null, men, seats, w.days).side
  if (league.scoring === 'categories') { const o = categoryWeek(a, w.side); return o.win + o.tie / 2 }
  return pointsWeek(a, w.side, league.points ?? {}, { mine: null, theirs: null }).win
}
const judge = (men: any[]) => { const each = weeks.map((w: any) => weekWin(men, w)); return { season: each.reduce((s: number, x: number) => s + x, 0), wk1: each[0] } }
const name = (id: string) => ctx.byId.get(id)?.name ?? id
let mine = teams.get(ME)!.men
const asIs = judge(mine)
for (const mv of (process.env.MOVES ?? '').split(';').filter(Boolean)) {
  const [out, inn] = mv.split('>')
  const add = players.find((p: any) => p.name === inn)
  if (!add || !mine.some((m) => name(m.id) === out)) throw new Error(`no such move: ${mv}`)
  mine = [...mine.filter((m) => name(m.id) !== out), man(add.yahoo!.yahooId)!]
  const r = judge(mine)
  console.log(`after ${out} > ${inn}: ${r.season.toFixed(2)} wins (${(r.season - asIs.season >= 0 ? '+' : '')}${(r.season - asIs.season).toFixed(2)} on the roster as is), week 1 ${Math.round(r.wk1 * 100)}%`)
}
const base = judge(mine)
console.log(`${teams.get(ME)!.name}: ${base.season.toFixed(2)} wins expected over ${weeks.length} weeks; week ${weeks[0].w} vs ${teams.get(weeks[0].opp)!.name} ${Math.round(base.wk1 * 100)}%`)
const fa = (d.fa as string).split(',').map(man).filter((x) => x && ctx.byId.get(x.id)?.projection) as { id: string; eligible: string[] }[]
const named = NAMED.split(',').filter(Boolean)
const pool = [...fa].sort((a, b) => ctx.worth(b.id) - ctx.worth(a.id)).slice(0, 60)
for (const n of named) { const x = fa.find((f) => name(f.id) === n); if (x && !pool.includes(x)) pool.push(x) }
const res: { add: string; drop: string; season: number; wk1: number }[] = []
for (const c of pool) for (const dr of mine) {
  const r = judge([...mine.filter((m) => m !== dr), c])
  res.push({ add: name(c.id), drop: name(dr.id), season: r.season - base.season, wk1: r.wk1 - base.wk1 })
}
const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`
console.log('\nBest adds (best drop each), season wins | week-1 win change')
const seen = new Set<string>()
for (const r of [...res].sort((a, b) => b.season - a.season)) { if (seen.has(r.add)) continue; seen.add(r.add); if (seen.size > 12) break; console.log(`${f(r.season)}  wk1 ${f(r.wk1 * 100).replace('.00', '')}pp  ${r.add.padEnd(24)} for ${r.drop}`) }
console.log('\nWho is least missed (best add for each drop)')
const byDrop = new Map<string, any>(); for (const r of [...res].sort((a, b) => b.season - a.season)) if (!byDrop.has(r.drop)) byDrop.set(r.drop, r)
for (const [dn, r] of byDrop) console.log(`${dn.padEnd(24)} ${f(r.season)} with ${r.add}`)
console.log('\nBest week-1 streams (season cost shown)')
const seen1 = new Set<string>()
for (const r of [...res].sort((a, b) => b.wk1 - a.wk1)) { if (seen1.has(r.add)) continue; seen1.add(r.add); if (seen1.size > 6) break; console.log(`wk1 ${f(r.wk1 * 100)}pp  season ${f(r.season)}  ${r.add.padEnd(24)} for ${r.drop}`) }
for (const n of named) {
  console.log(`\n${n}, by drop:`)
  for (const r of res.filter((x) => x.add === n).sort((a, b) => b.season - a.season)) console.log(`  for ${r.drop.padEnd(22)} season ${f(r.season)}  wk1 ${f(r.wk1 * 100)}pp`)
}
