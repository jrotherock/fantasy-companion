/**
 * Does the Yahoo queue the draft screen shows two picks out still take the right player if the clock runs
 * out? Drafts every slot of both leagues through buildView itself, the room down ADP with the league spread,
 * and counts the turns where the queue first player still there is the top card on the clock.
 *
 *   npx tsx scripts/nba-queue-check.ts [seeds]
 */
import { readFileSync } from 'node:fs'
import { buildView, prepare } from '../src/nba/plan.js'
import { emptyDraft } from '../src/nba/session.js'
import { adpFor } from '../src/nba/draft.js'
import { slotFor } from '../src/kernel/snake.js'
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
const SEEDS = Number(process.argv[2] ?? 3)
for (const lid of ['nba-hoops', 'nba-harker']) {
  const prep = prepare(leagues.find((l: any) => l.id === lid), players, noise, adpFor)
  const L = leagues.find((l: any) => l.id === lid)
  const teams = L.teams, rounds = prep.rounds
  let n = 0, ok = 0, t0 = Date.now()
  for (let seed = 1; seed <= SEEDS; seed++) for (let slot = 1; slot <= teams; slot++) {
    let s = seed * 7919 + slot
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
    const sp = L.adpSpread ?? { a: 2, b: 0.12 }
    const scatter = new Map(prep.adpOrder.map((id: string) => [id, prep.adp(id) + g() * (sp.a + sp.b * prep.adp(id))]))
    const d = emptyDraft('t'); d.slot = slot
    const taken = new Set<string>()
    let held: { pick: number; ids: string[] } | null = null
    for (let o = 1; o <= teams * rounds; o++) {
      const v = buildView(prep, d, new Map())
      if (!v.clock.onClock && v.queue && v.clock.picksUntil === 2) held = { pick: v.clock.myNext!, ids: v.queue.map((q) => q.id) }
      let id: string
      if (slotFor(o, teams) === slot) {
        if (held?.pick === o && v.takeNow[0]) { n++; if (held.ids.find((x) => !taken.has(x)) === v.takeNow[0].id) ok++ }
        id = v.takeNow[0]?.id ?? prep.adpOrder.find((x: string) => !taken.has(x))
      } else id = [...prep.adpOrder].filter((x: string) => !taken.has(x)).sort((a: string, b: string) => scatter.get(a)! - scatter.get(b)!)[0]
      taken.add(id)
      d.picks.push({ overall: o, playerId: id, name: id, source: 'manual' as const })
    }
  }
  console.log(`${lid}: queue's first left = the card on the clock in ${ok}/${n} turns (${(100 * ok / n).toFixed(1)}%) — ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}
