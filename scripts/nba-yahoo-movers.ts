/**
 * What a Yahoo ranking update changes, against our own board.
 *
 * Yahoo's default rank is the room's default queue and its ADP where people
 * take players; neither is a measure of value (data/nba/yahoo-ranks.json), so
 * this does not touch the values. It lists who moved, and for each one what our
 * board thinks: a riser we rate lower will go earlier than the cards expect,
 * a faller we rate well is a likely bargain.
 *
 *   npx tsx scripts/nba-yahoo-movers.ts <old players.json> [new players.json]
 */
import { readFileSync } from 'node:fs'
import { categoryZ, pointsValues, rankBuild } from '../src/nba/value.js'

const [oldFile, newFile = 'data/nba/players.json'] = process.argv.slice(2)
if (!oldFile) throw new Error('usage: nba-yahoo-movers.ts <old players.json> [new players.json]')
const before = JSON.parse(readFileSync(oldFile, 'utf8')).players as any[]
const after = JSON.parse(readFileSync(newFile, 'utf8')).players as any[]
const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
const hoops = leagues.find((l: any) => l.id === 'nba-hoops'), harker = leagues.find((l: any) => l.id === 'nba-harker')
const sims = new Map((JSON.parse(readFileSync('data/nba/draft-rank/nba-hoops.json', 'utf8')).players as any[]).map((p, i) => [p.name, i + 1]))

const catRank = new Map(rankBuild(categoryZ(after, hoops), hoops, []).map((r) => [r.id, r.rank]))
const ptsRank = new Map([...pointsValues(after, harker).rows].sort((a, b) => b.value - a.value).map((r, i) => [r.id, i + 1]))
const was = new Map(before.filter((p) => p.yahoo).map((p) => [p.id, p.yahoo]))

type Row = { name: string; team: string; oldRank: number | null; rank: number; oldAdp: number | null; adp: number | null; hoops: number | null; harker: number | null; sim: number | null }
const rows: Row[] = after.filter((p) => p.yahoo && p.yahoo.rank <= 200).map((p) => {
  const o = was.get(p.id)
  return {
    name: p.name, team: p.team ?? '—', oldRank: o?.rank ?? null, rank: p.yahoo.rank, oldAdp: o?.adp ?? null, adp: p.yahoo.adp ?? null,
    hoops: catRank.get(p.id) ?? null, harker: ptsRank.get(p.id) ?? null, sim: sims.get(p.name) ?? null,
  }
})
const moved = (r: Row) => (r.oldRank == null ? 999 : r.oldRank - r.rank)
const fmt = (r: Row) => `${r.name.padEnd(26)} ${r.team.padEnd(4)} Yahoo #${String(r.oldRank ?? 'new').padStart(3)} → #${String(r.rank).padStart(3)}   ADP ${r.oldAdp?.toFixed(1) ?? '—'} → ${r.adp?.toFixed(1) ?? '—'}   ours: Hoops value #${r.hoops ?? '—'}${r.sim ? `, sims #${r.sim}` : ''}, Harker #${r.harker ?? '—'}`

const same = rows.filter((r) => r.oldRank === r.rank).length
console.log(`Top 200 by Yahoo's new rank: ${same} unchanged, ${rows.filter((r) => r.oldRank == null).length} new to the list.`)
console.log('\nRisers (up 10+ places) — they will go earlier than before:')
for (const r of rows.filter((r) => moved(r) >= 10).sort((a, b) => moved(b) - moved(a))) {
  const flag = r.hoops != null && r.hoops > r.rank + 15 && r.harker != null && r.harker > r.rank + 15 ? '  ← we rate him well below this' : ''
  console.log('  ' + fmt(r) + flag)
}
console.log('\nFallers (down 10+ places) — they will go later than before:')
for (const r of rows.filter((r) => moved(r) <= -10).sort((a, b) => moved(a) - moved(b))) {
  const flag = (r.hoops != null && r.hoops < r.rank - 15) || (r.harker != null && r.harker < r.rank - 15) ? '  ← we rate him well above this: a likely bargain' : ''
  console.log('  ' + fmt(r) + flag)
}
const gone = before.filter((p) => p.yahoo && p.yahoo.rank <= 150 && !after.some((q) => q.id === p.id && q.yahoo && q.yahoo.rank <= 200))
if (gone.length) console.log(`\nOut of Yahoo's top 200 (were top 150): ${gone.map((p) => `${p.name} (#${p.yahoo.rank})`).join(', ')}`)
