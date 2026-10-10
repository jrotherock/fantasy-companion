import { readFileSync } from 'node:fs'
import { perGameBox } from '../../src/nba/outlook.js'
import { projectWeek, startingSeats } from '../../src/nba/week.js'
import { seatPositions } from '../../src/nba/inseason.js'
import { categoryWeek } from '../../src/nba/matchup.js'
import { emptyBox } from '../../src/nba/yahooSeason.js'
const S = process.argv[2]
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const games = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games as any[]
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === 'nba-public')
const seats = startingSeats(league.roster)
const d = JSON.parse(readFileSync(`${S}/sched.json`, 'utf8'))
const byY = new Map(players.filter((p) => p.yahoo).map((p) => [p.yahoo.yahooId, p]))
const teams = new Map<string, { name: string; ids: string[] }>()
const missing: string[] = []
for (const line of d.rosters.split('\n')) {
  const [tid, name, list] = line.split('~')
  const ids = list.split(',').filter((x: string) => !x.endsWith('i')).map((y: string) => { const p = byY.get(y); if (!p) missing.push(y); return p?.id }).filter(Boolean)
  teams.set(tid, { name, ids })
}
const ME = '2'
const weeks = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); const opp = pairs.split(',').map((x: string) => x.split('-')).find((x: string[]) => x.includes(ME))!; return { w: +w, start: a, end: b, opp: opp[0] === ME ? opp[1] : opp[0] } })
const playing = new Map<string, Set<string>>()
for (const g of games) { const s = playing.get(g.date) ?? new Set(); s.add(g.home); s.add(g.away); playing.set(g.date, s) }
const daysOf = (a: string, b: string) => { const out: string[] = []; for (let t = Date.parse(a); t <= Date.parse(b); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out }
const P = new Map(players.map((p) => [p.id, p]))
const avail = (p: any) => Math.min(1, (p.projection?.gp ?? 60) / 82)
const fp = (b: any) => b.pts + 1.2 * b.reb + 1.5 * b.ast + 3 * b.stl + 3 * b.blk - b.to
const boxes = new Map<string, any>()
const boxOf = (id: string) => { let b = boxes.get(id); if (!b) { b = perGameBox(P.get(id)); boxes.set(id, b) } return b }
const cache = new Map<string, any>()
function side(ids: string[], wk: { start: string; end: string }) {
  const key = ids.slice().sort().join(',') + wk.start
  const hit = cache.get(key); if (hit) return hit
  const out = projectWeek({
    men: ids.map((id) => { const p = P.get(id); return { id, name: p.name, positions: seatPositions(p.yahoo?.positions ?? p.positions), team: p.team } }),
    seats, days: daysOf(wk.start, wk.end),
    playing: (date: string) => playing.get(date) ?? new Set(),
    outlook: (id: string) => ({ box: boxOf(id), play: avail(P.get(id)) }),
    worth: (id: string) => fp(boxOf(id)) * avail(P.get(id)) + 100,
  } as any)
  const s = { now: emptyBox(), rest: out.box, restVar: out.variance }
  cache.set(key, s); return s
}
const season = (mine: string[]) => weeks.map((wk: any) => { const o = categoryWeek(side(mine, wk), side(teams.get(wk.opp)!.ids, wk)); return { ...wk, exp: o.expected, win: o.win + o.tie / 2, races: o.races } })
const sum = (r: any[], k: string) => r.reduce((a, x) => a + x[k], 0)
const mine = teams.get(ME)!.ids
const base = season(mine)
console.log('missing yahoo ids', missing.join(',') || 'none')
console.log(`Now: ${sum(base, 'win').toFixed(2)} expected matchup wins of 19, ${(sum(base, 'exp') / 19).toFixed(2)} cats a week`)
if (0) for (const r of base) console.log(`wk ${String(r.w).padStart(2)} ${r.start}  vs ${teams.get(r.opp)!.name.padEnd(25)} ${r.exp.toFixed(2)} cats  win ${Math.round(r.win * 100)}%  ` + r.races.filter((x: any) => x.win > 0.35 && x.win < 0.65).map((x: any) => x.cat).join(' '))

const rostered = new Set([...teams.values()].flatMap((t) => t.ids))
for (const l of d.rosters.split('\n')) for (const x of l.split('~')[2].split(',')) if (x.endsWith('i')) { const p = byY.get(x.slice(0, -1)); if (p) rostered.add(p.id) }
const pool = players.filter((p) => p.yahoo && p.projection && p.team && !rostered.has(p.id))
const W1 = weeks[0], opp1 = teams.get(W1.opp)!.ids
const wk = (ids: string[], i = 0) => { const w = weeks[i]; const o = categoryWeek(side(ids, w), side(teams.get(w.opp)!.ids, w)); return o.win + o.tie / 2 }
const b1 = wk(mine)
const id = (n: string) => players.find((p) => p.name === n).id
const nm = (i: string) => P.get(i).name

const total = (plan: (w: number) => string[]) => weeks.reduce((a: number, _: any, i: number) => a + wk(plan(i), i), 0)
const baseT = total(() => mine)
const rep = (ids: string[], ...pairs: [string, string][]) => { let out = ids; for (const [o, n] of pairs) out = out.map((x) => (x === id(o) ? id(n) : x)); return out }
const MB = 'Miles Bridges', FVV = 'Fred VanVleet', MT = 'Myles Turner', DD = 'DeMar DeRozan', CS = 'Collin Sexton', AN = 'Andrew Nembhard', JJ = 'Jaime Jaquez'
const paths: [string, (w: number) => string[]][] = [
  ['Keep everyone', () => mine],
  ['DeRozan for Turner now', () => rep(mine, [MT, DD])],
  ['DeRozan for VanVleet now', () => rep(mine, [FVV, DD])],
  ['DeRozan for Bridges now', () => rep(mine, [MB, DD])],
  ['DeRozan for Herro now', () => rep(mine, ['Tyler Herro', DD])],
  ['Sexton for Bridges wk1; then Bridges back', (i) => (i === 0 ? rep(mine, [MB, CS]) : mine)],
  ['Sexton for Bridges wk1; then DeRozan in Sexton\'s place', (i) => (i === 0 ? rep(mine, [MB, CS]) : rep(mine, [MB, DD]))],
  ['Sexton for Bridges wk1; then Bridges back + DeRozan for VanVleet', (i) => (i === 0 ? rep(mine, [MB, CS]) : rep(mine, [FVV, DD]))],
  ['Sexton for Bridges wk1; then Bridges back + DeRozan for Turner', (i) => (i === 0 ? rep(mine, [MB, CS]) : rep(mine, [MT, DD]))],
  ['DeRozan for VanVleet now + Sexton for Bridges wk1, Bridges back', (i) => (i === 0 ? rep(mine, [FVV, DD], [MB, CS]) : rep(mine, [FVV, DD]))],
  ['Nembhard+Jaquez for VanVleet+Bridges wk1; then Bridges back + DeRozan for VanVleet', (i) => (i === 0 ? rep(mine, [FVV, AN], [MB, JJ]) : rep(mine, [FVV, DD]))],
]
console.log('Path'.padEnd(84) + 'wk1   wk2   season wins (change)')
for (const [label, plan] of paths) { const t = total(plan); console.log(`${label.padEnd(84)}${String(Math.round(wk(plan(0), 0) * 100)).padStart(3)}%  ${String(Math.round(wk(plan(1), 1) * 100)).padStart(3)}%  ${t.toFixed(2)} (${t - baseT >= 0 ? '+' : ''}${(t - baseT).toFixed(2)})`) }
const dd = P.get(id(DD)), mt = P.get(id(MT)), kp = P.get(id('Kristaps Porziņģis'))
for (const p of [dd, mt, kp, P.get(id(FVV))]) console.log(p.name, p.team, (p.yahoo?.positions ?? []).join('/'), 'gp', Math.round(p.projection.gp), 'dur', JSON.stringify(p.durability), Object.fromEntries(Object.entries(p.projection.perGame).map(([k, v]: any) => [k, +v.toFixed(1)])), p.projection.shooting.fgPct, p.projection.shooting.ftPct)
