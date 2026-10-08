/**
 * Are the round-2 cards the same whatever I did in round 1? For each slot and
 * each plausible first pick, the room drafts by ADP around me, and this prints
 * the top cards at my second pick with what they cost and what else was left.
 *
 *   npx tsx scripts/nba-card-spread.ts [league=nba-hoops]
 */
import { readFileSync } from 'node:fs'
import { prepare, buildView } from '../src/nba/plan.js'
import { emptyDraft } from '../src/nba/session.js'
import { adpFor } from '../src/nba/draft.js'

const LEAGUE = process.argv[2] ?? 'nba-hoops'
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
let file = null
try { file = JSON.parse(readFileSync(`data/nba/draft-rank/${LEAGUE}.json`, 'utf8')) } catch {}
const prep = prepare(leagues.find((l: any) => l.id === LEAGUE), players, noise, adpFor, {}, null, {}, file)
const n = prep.league.teams
const name = (id: string) => prep.players.get(id)!.name
const idOf = new Map([...prep.players.values()].map((p: any) => [p.name, p.id]))
const FIRSTS = ['Nikola Jokić', 'Shai Gilgeous-Alexander', 'Victor Wembanyama', 'Luka Dončić', 'Tyrese Maxey', 'Cade Cunningham', 'Giannis Antetokounmpo', 'Anthony Edwards', 'Karl-Anthony Towns', 'Scottie Barnes']
const tags = new Map<string, any>([['Joel Embiid', 'never'], ['Kristaps Porziņģis', 'never'], ['Anthony Davis', 'avoid']].map(([nm, t]) => [idOf.get(nm)!, t]).filter(([id]) => id))

for (let slot = 1; slot <= 7; slot++) {
  const second = 2 * n - slot + 1
  console.log(`\nSlot ${slot} — second pick is #${second}`)
  // Who the room takes before my first pick: ADP order.
  const before = prep.adpOrder.slice(0, slot - 1)
  for (const first of FIRSTS) {
    const me = idOf.get(first)!
    if (before.includes(me)) continue
    const rest = prep.adpOrder.filter((id) => id !== me && !before.includes(id))
    const picks: string[] = [...before, me, ...rest.slice(0, second - slot - 1)]
    const d = emptyDraft('t'); d.slot = slot
    d.picks = picks.map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
    const v = buildView(prep, d, tags)
    const cards = v.advice.slice(0, 3).map((a) => `${a.name} ${a.score.toFixed(3)}`).join(' · ')
    console.log(`  ${first.padEnd(24)} → ${cards}`)
  }
}

// One room in detail: the top ten cards at slot 5 after each of two very different first picks.
if (process.env.DETAIL) for (const first of ['Tyrese Maxey', 'Giannis Antetokounmpo']) {
  const slot = 5, second = 2 * n - slot + 1, me = idOf.get(first)!
  const before = prep.adpOrder.slice(0, slot - 1)
  const rest = prep.adpOrder.filter((id) => id !== me && !before.includes(id))
  const d = emptyDraft('t'); d.slot = slot
  d.picks = [...before, me, ...rest.slice(0, second - slot - 1)].map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  const v = buildView(prep, d, tags)
  const row = new Map(v.board.map((r) => [r.id, r]))
  console.log(`\nSlot 5 after ${first}:`)
  v.advice.slice(0, 10).forEach((a) => { const r = row.get(a.id)!; console.log(`  ${a.name.padEnd(24)} ${a.score.toFixed(3)}  ${r.positions.join('/').padEnd(6)} ADP ${r.adp}  Val ${r.rank}  Draft rank ${r.draftRank ?? '—'}`) })
}
