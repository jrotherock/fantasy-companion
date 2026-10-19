/**
 * A category league's season played out against the real schedule: every team's odds each week
 * (projectWeek's seating, categoryWeek's odds), the W-L table, my weeks, and the best adds from the
 * players nobody rostered. Rosters in the snapshot hold app player ids.
 *
 *   npx tsx scripts/nba-season-analysis/cats-season.ts scripts/nba-season-analysis/2026-10-18-hoops nba-hoops 4
 */
import { readFileSync } from 'node:fs'
import { perGameBox } from '../../src/nba/outlook.js'
import { projectWeek, startingSeats } from '../../src/nba/week.js'
import { seatPositions } from '../../src/nba/inseason.js'
import { categoryWeek } from '../../src/nba/matchup.js'
import { emptyBox } from '../../src/nba/yahooSeason.js'

const [S, LEAGUE = 'nba-hoops', ME = '4'] = process.argv.slice(2)
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const games = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games as any[]
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === LEAGUE)
const seats = startingSeats(league.roster)
const d = JSON.parse(readFileSync(`${S}/sched.json`, 'utf8'))
const P = new Map(players.map((p) => [p.id, p]))
const teams = new Map<string, { name: string; ids: string[] }>()
for (const line of d.rosters.split('\n')) { const [tid, name, list] = line.split('~'); teams.set(tid, { name, ids: list.split(',').filter((id: string) => P.has(id)) }) }
const weeks = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); return { w: +w, start: a, end: b, pairs: pairs.split(',').map((x: string) => x.split('-')) } })
const playing = new Map<string, Set<string>>()
for (const g of games) { const s = playing.get(g.date) ?? new Set(); s.add(g.home); s.add(g.away); playing.set(g.date, s) }
const daysOf = (a: string, b: string) => { const out: string[] = []; for (let t = Date.parse(a); t <= Date.parse(b); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out }
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
const oppOf = (wk: any, t: string) => { const p = wk.pairs.find((x: string[]) => x.includes(t)); return p[0] === t ? p[1] : p[0] }
const seasonOf = (tid: string, ids: string[]) => weeks.map((wk: any) => { const o = categoryWeek(side(ids, wk), side(teams.get(oppOf(wk, tid))!.ids, wk)); return { w: wk.w, opp: oppOf(wk, tid), exp: o.expected, win: o.win + o.tie / 2, races: o.races } })
const sum = (r: any[], k: string) => r.reduce((a, x) => a + x[k], 0)
const n = weeks.length

const table = [...teams].map(([tid, t]) => { const r = seasonOf(tid, t.ids); return { tid, name: t.name, w: sum(r, 'win'), cats: sum(r, 'exp') / n } }).sort((a, b) => b.w - a.w)
console.log(`${n} regular-season weeks`)
console.log('team'.padEnd(26), 'W-L          cats/wk')
for (const r of table) console.log(`${(r.name + (r.tid === ME ? ' ★' : '')).padEnd(26)} ${r.w.toFixed(1)}-${(n - r.w).toFixed(1)}    ${r.cats.toFixed(2)}`)

const mine = teams.get(ME)!.ids
const base = seasonOf(ME, mine)
console.log('\nmy weeks:')
for (const r of base) console.log(`wk ${String(r.w).padStart(2)} vs ${teams.get(r.opp)!.name.padEnd(22)} ${r.exp.toFixed(2)} cats  win ${Math.round(r.win * 100)}%   swing: ${r.races.filter((x: any) => x.win > 0.35 && x.win < 0.65).map((x: any) => x.cat).join(' ')}`)
const avgCat: Record<string, number> = {}
for (const r of base) for (const x of r.races) avgCat[x.cat] = (avgCat[x.cat] ?? 0) + x.win / n
console.log('\naverage odds per category:', Object.entries(avgCat).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join('  '))

const rostered = new Set([...teams.values()].flatMap((t) => t.ids))
const pool = players.filter((p) => p.projection && p.team && !rostered.has(p.id) && !p.injury?.out).sort((a, b) => fp(boxOf(b.id)) * avail(b) - fp(boxOf(a.id)) * avail(a)).slice(0, 80)
const res: any[] = []
for (const c of pool) for (const dr of mine) {
  const r = seasonOf(ME, mine.map((x) => (x === dr ? c.id : x)))
  res.push({ add: c.name, pos: (c.yahoo?.positions ?? c.positions).join('/'), drop: P.get(dr).name, win: sum(r, 'win') - sum(base, 'win'), exp: (sum(r, 'exp') - sum(base, 'exp')) / n })
}
res.sort((a, b) => b.win - a.win)
const seen = new Set<string>()
console.log('\nbest adds over the season (best drop for each), in expected matchup wins')
for (const r of res.filter((r) => (seen.has(r.add) ? false : (seen.add(r.add), true))).slice(0, 12)) console.log(`${r.win >= 0 ? '+' : ''}${r.win.toFixed(2)} wins  ${r.exp >= 0 ? '+' : ''}${r.exp.toFixed(3)} cats/wk  ${r.add.padEnd(22)} ${r.pos.padEnd(10)} for ${r.drop}`)
console.log('\nleast-missed drops (best add for each)')
const byDrop = new Map<string, any>(); for (const r of res) if (!byDrop.has(r.drop)) byDrop.set(r.drop, r)
for (const [dn, r] of [...byDrop].sort((a, b) => b[1].win - a[1].win).slice(0, 5)) console.log(`${dn.padEnd(20)} best replacement ${r.add} ${r.win >= 0 ? '+' : ''}${r.win.toFixed(2)} wins`)
