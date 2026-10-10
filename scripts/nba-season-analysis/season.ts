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
for (const r of base) console.log(`wk ${String(r.w).padStart(2)} ${r.start}  vs ${teams.get(r.opp)!.name.padEnd(25)} ${r.exp.toFixed(2)} cats  win ${Math.round(r.win * 100)}%  ` + r.races.filter((x: any) => x.win > 0.35 && x.win < 0.65).map((x: any) => x.cat).join(' '))
const rostered = new Set([...teams.values()].flatMap((t) => t.ids))
const ilIds = d.rosters.split('\n').flatMap((l: string) => l.split('~')[2].split(',').filter((x: string) => x.endsWith('i')).map((x: string) => byY.get(x.slice(0, -1))?.id)).filter(Boolean)
for (const x of ilIds) rostered.add(x)
const pool = players.filter((p) => p.yahoo && p.projection && p.team && !rostered.has(p.id)).sort((a, b) => fp(boxOf(b.id)) * avail(b) - fp(boxOf(a.id)) * avail(a)).slice(0, 90)
const res: any[] = []
for (const c of pool) for (const dr of mine) {
  const after = mine.map((x) => (x === dr ? c.id : x))
  const r = season(after)
  res.push({ add: c.name, pos: (c.yahoo?.positions ?? c.positions).join('/'), drop: P.get(dr).name, win: sum(r, 'win') - sum(base, 'win'), exp: (sum(r, 'exp') - sum(base, 'exp')) / 19 })
}
res.sort((a, b) => b.win - a.win)
const seen = new Set<string>()
console.log('\nBest adds over weeks 1-19 (best drop for each), in expected matchup wins')
for (const r of res.filter((r) => (seen.has(r.add) ? false : (seen.add(r.add), true))).slice(0, 15)) console.log(`${r.win >= 0 ? '+' : ''}${r.win.toFixed(2)} wins  ${r.exp >= 0 ? '+' : ''}${r.exp.toFixed(3)} cats/wk  ${r.add.padEnd(22)} ${r.pos.padEnd(12)} for ${r.drop}`)
console.log('\nNamed')
for (const n of ['Collin Sexton', 'Reed Sheppard', 'Matisse Thybulle', 'Brook Lopez', 'Isaiah Stewart', 'Dereck Lively', 'Jimmy Butler']) { const r = res.filter((x) => x.add === n).sort((a, b) => b.win - a.win); if (r[0]) console.log(`${n.padEnd(18)} best: for ${r[0].drop} ${r[0].win.toFixed(2)} wins ${r[0].exp.toFixed(3)} c/wk; for Miles Bridges ${r.find((x) => x.drop === 'Miles Bridges')!.win.toFixed(2)}`) }
console.log('\nDrops: who is least missed (best add for each drop)')
const byDrop = new Map<string, any>(); for (const r of res) if (!byDrop.has(r.drop)) byDrop.set(r.drop, r)
for (const [dn, r] of [...byDrop].sort((a, b) => b[1].win - a[1].win)) console.log(`${dn.padEnd(20)} best replacement ${r.add} ${r.win.toFixed(2)} wins`)
const swap = (a: string, b: string) => mine.map((x) => (P.get(x).name === b ? players.find((p) => p.name === a).id : x))
for (const [a, b] of [['Collin Sexton', 'Miles Bridges'], ['DeMar DeRozan', 'Myles Turner'], ['DeMar DeRozan', 'Fred VanVleet']] as const) {
  const r = season(swap(a, b))
  console.log(`${a} for ${b}: ` + r.map((x: any, i: number) => `w${x.w} ${(x.win - base[i].win) >= 0 ? '+' : ''}${Math.round((x.win - base[i].win) * 100)}`).join(' '))
}
console.log('DeRozan', JSON.stringify(players.find((p) => p.name === 'DeMar DeRozan').yahoo), players.find((p) => p.name === 'DeMar DeRozan').projection.gp)
