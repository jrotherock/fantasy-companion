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
console.log(`Week 1 as is: ${Math.round(b1 * 100)}%`)
const singles: any[] = []
for (const c of pool) for (const dr of mine) { const after = mine.map((x) => (x === dr ? c.id : x)); singles.push({ add: c.id, drop: dr, w: wk(after) }) }
singles.sort((a, b) => b.w - a.w)
console.log('\nBest single swaps for week 1')
for (const s of singles.slice(0, 12)) console.log(`${Math.round(s.w * 100)}%  ${nm(s.add)} (${(P.get(s.add).yahoo?.positions ?? []).join('/')}, ${P.get(s.add).team}) for ${nm(s.drop)}`)
console.log(`Sexton for Miles Bridges: ${Math.round(singles.find((s) => nm(s.add) === 'Collin Sexton' && nm(s.drop) === 'Miles Bridges').w * 100)}%`)
// Doubles: from the top singles' adds, two adds for two different drops.
const topAdds = [...new Set(singles.slice(0, 400).map((s) => s.add))].slice(0, 25)
let best: any[] = []
for (let i = 0; i < topAdds.length; i++) for (let j = i + 1; j < topAdds.length; j++) for (const d1 of mine) for (const d2 of mine) {
  if (d1 >= d2) continue
  const after = mine.map((x) => (x === d1 ? topAdds[i] : x === d2 ? topAdds[j] : x))
  best.push({ a: [topAdds[i], topAdds[j]], d: [d1, d2], w: wk(after) })
}
best.sort((a, b) => b.w - a.w)
console.log('\nBest double swaps for week 1')
for (const s of best.slice(0, 6)) console.log(`${Math.round(s.w * 100)}%  ${nm(s.a[0])} + ${nm(s.a[1])} for ${nm(s.d[0])} + ${nm(s.d[1])}`)
// Paths over weeks 1-19.
const total = (plan: (w: number) => string[]) => weeks.reduce((a: number, _: any, i: number) => a + wk(plan(i), i), 0)
const baseT = total(() => mine)
const rep = (ids: string[], out: string, inn: string) => ids.map((x) => (x === id(out) ? id(inn) : x))
const sexton = rep(mine, 'Miles Bridges', 'Collin Sexton')
const paths: [string, (w: number) => string[]][] = [
  ['Keep everyone', () => mine],
  ['Sexton for Bridges all season', () => sexton],
  ['Sexton wk 1, Bridges back from wk 2', (i) => (i === 0 ? sexton : mine)],
  ['Sexton wk 1, then Sheppard for Sexton', (i) => (i === 0 ? sexton : rep(mine, 'Miles Bridges', 'Reed Sheppard'))],
  ['Sexton for VanVleet all season', () => rep(mine, 'Fred VanVleet', 'Collin Sexton')],
  ['Sexton for VanVleet wk 1, VanVleet back', (i) => (i === 0 ? rep(mine, 'Fred VanVleet', 'Collin Sexton') : mine)],
]
const s0 = singles[0]
paths.push([`Best wk-1 single (${nm(s0.add)} for ${nm(s0.drop)}), back after`, (i) => (i === 0 ? mine.map((x) => (x === s0.drop ? s0.add : x)) : mine)])
const d0 = best[0]
paths.push([`Best wk-1 double, both back after`, (i) => (i === 0 ? mine.map((x) => (x === d0.d[0] ? d0.a[0] : x === d0.d[1] ? d0.a[1] : x)) : mine)])
console.log('\nPaths, weeks 1-19: week 1 win %, expected wins (change)')
for (const [label, plan] of paths) { const t = total(plan); console.log(`${label.padEnd(52)} wk1 ${Math.round(wk(plan(0)) * 100)}%   ${t.toFixed(2)} (${t - baseT >= 0 ? '+' : ''}${(t - baseT).toFixed(2)})`) }
