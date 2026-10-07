/**
 * The board's Draft rank for a categories league, from the first-pick test.
 *
 * Each player was forced as my first pick (held back from the room until then)
 * in the same rooms, slots 5 and 10, and the season played out in box scores —
 * once with the cards drafting the rest, once with a neutral best-value drafter,
 * so neither way of drafting decides the order alone. His score is the average
 * of the two: weeks won in 100 against the app's own first pick in the same room.
 *
 * Tiers by rule rather than by eye: a new tier starts where a player is 1.5 or
 * more weeks in 100 behind the first of the current one (about one and a half
 * standard errors). Inside a tier the order is the point estimate, which is noise.
 *
 *   npx tsx scripts/nba-draft-rank.ts <cards.jsonl> <neutral.jsonl> <league-id>
 *     → data/nba/draft-rank/<league-id>.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const [cardsFile, neutralFile, league] = process.argv.slice(2)
if (!league) throw new Error('usage: nba-draft-rank.ts <cards.jsonl> <neutral.jsonl> <league-id>')
const TIER_GAP = 1.5

type Line = { first: string | null; slot: number; seed: number; ap: number }
function diffs(file: string): Map<string, number[]> {
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line)
  const base = new Map(lines.filter((l) => l.first == null).map((l) => [`${l.slot}:${l.seed}`, l.ap]))
  const by = new Map<string, number[]>()
  for (const l of lines) {
    if (l.first == null) continue
    const b = base.get(`${l.slot}:${l.seed}`)
    if (b != null) (by.get(l.first) ?? by.set(l.first, []).get(l.first)!).push((l.ap - b) * 100)
  }
  return by
}
const mean = (x: number[]) => x.reduce((s, y) => s + y, 0) / x.length
const se = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((s, y) => s + (y - m) ** 2, 0) / (x.length - 1) / x.length) }

const a = diffs(cardsFile), v = diffs(neutralFile)
const rows = [...a.keys()].filter((n) => v.has(n)).map((name) => ({
  name,
  delta: Math.round(((mean(a.get(name)!) + mean(v.get(name)!)) / 2) * 100) / 100,
  err: Math.round(Math.sqrt(se(a.get(name)!) ** 2 + se(v.get(name)!) ** 2) * 2 * 100) / 100,
})).sort((x, y) => y.delta - x.delta)

let tier = 0, top = Infinity
const players = rows.map((r) => {
  if (r.delta <= top - TIER_GAP) { tier++; top = r.delta }
  if (tier === 0) { tier = 1; top = r.delta }
  return { ...r, tier }
})
mkdirSync('data/nba/draft-rank', { recursive: true })
writeFileSync(`data/nba/draft-rank/${league}.json`, JSON.stringify({
  built: new Date().toISOString(),
  method: 'First-pick test, box-score seasons: each player forced as my first pick in the same rooms (slots 5 and 10), the rest drafted by the cards and by a neutral best-value drafter; delta is weeks won in 100 against the app\'s own first pick, averaged over both. err is two standard errors.',
  tierGap: TIER_GAP,
  players,
}, null, 1))
console.log(players.map((p, i) => `${i + 1} T${p.tier} ${p.name} ${p.delta}`).join('\n'))
