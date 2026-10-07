/**
 * The first-pick test as a ranking: each player forced as my first pick (held
 * back from the room until then), the cards drafting the rest, the season
 * played out in box scores. Read from the per-draft lines nba-strategy-sim.ts
 * writes with --dump; each player is compared with the app's own first pick in
 * the same room (same slot and seed), which takes most of the luck out.
 *
 *   npx tsx scripts/nba-pool-rank.ts pool.jsonl [top=50]
 */
import { readFileSync } from 'node:fs'
import { categoryZ, rankBuild } from '../src/nba/value.js'

const [file, topArg] = process.argv.slice(2)
const TOP = Number(topArg ?? 50)
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { first: string | null; slot: number; seed: number; ap: number })
const base = new Map(lines.filter((l) => l.first == null).map((l) => [`${l.slot}:${l.seed}`, l.ap]))
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const hoops = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === 'nba-hoops')
const valueRank = new Map(rankBuild(categoryZ(players, hoops), hoops, []).map((r) => [r.name, r.rank]))
const adp = new Map(players.map((p: any) => [p.name, p.yahoo?.adp ?? null]))

const by = new Map<string, number[]>()
const apBy = new Map<string, number[]>()
for (const l of lines) {
  if (l.first == null) continue
  const b = base.get(`${l.slot}:${l.seed}`)
  if (b == null) continue
  ;(by.get(l.first) ?? by.set(l.first, []).get(l.first)!).push(l.ap - b)
  ;(apBy.get(l.first) ?? apBy.set(l.first, []).get(l.first)!).push(l.ap)
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const se = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) }
const rows = [...by.entries()].map(([name, d]) => ({ name, n: d.length, diff: mean(d) * 100, err: 2 * se(d) * 100, ap: mean(apBy.get(name)!) * 100 }))
  .sort((a, b) => b.diff - a.diff)
console.log(`baseline: the app's own first pick, ${base.size} drafts, ${(mean([...base.values()]) * 100).toFixed(1)}% of weeks`)
console.log(" #  player                     weeks won vs the app's pick (±2se)   value rank   ADP")
rows.slice(0, TOP).forEach((r, i) => {
  const a = adp.get(r.name) as number | null
  console.log(`${String(i + 1).padStart(2)}  ${r.name.padEnd(26)} ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(1).padStart(5)} ±${r.err.toFixed(1)}   (${r.ap.toFixed(1)}%, n ${r.n})   ${String(valueRank.get(r.name) ?? '—').padStart(5)}   ${a != null ? a.toFixed(1) : '—'}`)
})
