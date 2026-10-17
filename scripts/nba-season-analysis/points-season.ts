/**
 * A points league's season played out against the real schedule (Harker, 2026-10-16): every team's projected
 * points each week from its daily lineups (projectWeek's seating), and the chance of beating that week's
 * opponent with the week-to-week spread the app uses (POINTS_WEEK_CV of the week's points).
 *
 *   npx tsx scripts/nba-season-analysis/points-season.ts scripts/nba-season-analysis/2026-10-16-harker [me] [swap]
 *
 * `swap` is "out>in" by Yahoo player id, to try a move on my roster (e.g. a waiver claim).
 */
import { readFileSync } from 'node:fs'
import { perGameBox } from '../../src/nba/outlook.js'
import { projectWeek, startingSeats } from '../../src/nba/week.js'
import { seatPositions } from '../../src/nba/inseason.js'
import { POINTS_WEEK_CV } from '../../src/nba/strength.js'

const S = process.argv[2]
const ME = process.argv[3] ?? '3'
const SWAP = process.argv[4]
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const games = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games as any[]
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === 'nba-harker')
const seats = startingSeats(league.roster)
const W = league.points as Record<string, number>
const d = JSON.parse(readFileSync(`${S}/sched.json`, 'utf8'))
const byY = new Map(players.filter((p) => p.yahoo).map((p) => [p.yahoo.yahooId, p]))
const teams = new Map<string, { name: string; ids: string[] }>()
const missing: string[] = []
for (const line of d.rosters.split('\n')) {
  const [tid, name, list] = line.split('~')
  let ys: string[] = list.split(',').filter((x: string) => !x.endsWith('i'))
  if (tid === ME && SWAP) { const [out, inn] = SWAP.split('>'); ys = ys.map((y) => (y === out ? inn : y)) }
  const ids = ys.map((y) => { const p = byY.get(y); if (!p) missing.push(`${name}:${y}`); return p?.id }).filter(Boolean) as string[]
  teams.set(tid, { name, ids })
}
const weeks = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); return { w: +w, start: a, end: b, pairs: pairs.split(',').map((x: string) => x.split('-')) } })
const playing = new Map<string, Set<string>>()
for (const g of games) { const s = playing.get(g.date) ?? new Set(); s.add(g.home); s.add(g.away); playing.set(g.date, s) }
const daysOf = (a: string, b: string) => { const out: string[] = []; for (let t = Date.parse(a); t <= Date.parse(b); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out }
const P = new Map(players.map((p) => [p.id, p]))
const avail = (p: any) => Math.min(1, (p.projection?.gp ?? 60) / 82)
const fp = (b: any) => Object.entries(W).reduce((s, [k, w]) => s + w * (b[k] ?? 0), 0)
const boxes = new Map<string, any>()
const boxOf = (id: string) => { let b = boxes.get(id); if (!b) { b = perGameBox(P.get(id)); boxes.set(id, b) } return b }
function weekPoints(ids: string[], wk: { start: string; end: string }): number {
  const out = projectWeek({
    men: ids.map((id) => { const p = P.get(id); return { id, name: p.name, positions: seatPositions(p.yahoo?.positions ?? p.positions), team: p.team } }),
    seats, days: daysOf(wk.start, wk.end),
    playing: (date: string) => playing.get(date) ?? new Set(),
    outlook: (id: string) => ({ box: boxOf(id), play: avail(P.get(id)) }),
    worth: (id: string) => fp(boxOf(id)) * avail(P.get(id)) + 100,
  } as any)
  return fp(out.box)
}
const phi = (x: number) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x ** 3)))
const winP = (a: number, b: number) => phi((a - b) / Math.hypot(POINTS_WEEK_CV * a, POINTS_WEEK_CV * b))

const rec = new Map<string, { w: number; pts: number; opp: number; weeks: { w: number; opp: string; me: number; them: number; p: number }[] }>()
for (const tid of teams.keys()) rec.set(tid, { w: 0, pts: 0, opp: 0, weeks: [] })
for (const wk of weeks) {
  const pts = new Map([...teams].map(([tid, t]) => [tid, weekPoints(t.ids, wk)]))
  for (const [a, b] of wk.pairs) for (const [x, y] of [[a, b], [b, a]]) {
    const r = rec.get(x)!, p = winP(pts.get(x)!, pts.get(y)!)
    r.w += p; r.pts += pts.get(x)!; r.opp += pts.get(y)!
    r.weeks.push({ w: wk.w, opp: y, me: pts.get(x)!, them: pts.get(y)!, p })
  }
}
const n = weeks.length
console.log('missing yahoo ids:', missing.join(', ') || 'none')
console.log('team'.padEnd(26), 'W-L        pts/wk  opp pts/wk')
for (const [tid, r] of [...rec].sort((a, b) => b[1].w - a[1].w)) {
  console.log(`${(teams.get(tid)!.name + (tid === ME ? ' ★' : '')).padEnd(26)} ${r.w.toFixed(1)}-${(n - r.w).toFixed(1)}   ${(r.pts / n).toFixed(0)}    ${(r.opp / n).toFixed(0)}`)
}
console.log('\nmy weeks:')
for (const x of rec.get(ME)!.weeks) console.log(`wk ${String(x.w).padStart(2)} vs ${teams.get(x.opp)!.name.padEnd(24)} ${x.me.toFixed(0)} - ${x.them.toFixed(0)}  win ${Math.round(x.p * 100)}%`)
