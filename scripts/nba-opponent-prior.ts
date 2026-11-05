/**
 * Last season's opponent totals, the starting point for each team's factor (src/nba/opponent.ts): per defense and
 * group (G, F, C), the minutes and stats its opponents had, from Sleeper's weekly game logs.
 *
 *   npx tsx scripts/nba-opponent-prior.ts 2025 > data/nba/opponent-2025.json
 */
import { STATS, type Allowed, type Group } from '../src/nba/opponent.js'

const season = Number(process.argv[2] ?? 2025)
const groupOf = (pos: string | undefined): Group => (pos === 'C' ? 'C' : pos === 'SF' || pos === 'PF' ? 'F' : 'G')
const zero = () => Object.fromEntries(STATS.map((s) => [s, 0])) as Record<(typeof STATS)[number], number>
const out: Allowed = { league: { G: { min: 0, s: zero() }, F: { min: 0, s: zero() }, C: { min: 0, s: zero() } }, teams: {}, games: {} }
const seen = new Map<string, Set<string>>()
const rows = new Map<string, any>()
for (let w = 1; w <= 30; w++) {
  const res = await fetch(`https://api.sleeper.app/stats/nba/${season}/${w}?season_type=regular`)
  const list = res.ok ? await res.json() : []
  if (!Array.isArray(list) || !list.length) { if (w > 20) break; continue }
  for (const r of list) if (r?.player_id && r.date) rows.set(`${r.player_id}|${r.date}`, r)
}
for (const r of rows.values()) {
  const st = r.stats, min = (st?.sp ?? 0) / 60
  // A team-total row per game (TEAM_DEN) sits among the players' rows.
  if (!st || min <= 0 || !r.opponent || String(r.player_id).startsWith('TEAM_')) continue
  const g = groupOf(r.player?.position)
  const t = (out.teams[`${r.opponent}|${g}`] ??= { min: 0, s: zero() })
  for (const x of [t, out.league[g]]) { x.min += min; for (const s of STATS) x.s[s] += Number(st[s] ?? 0) }
  let d = seen.get(r.opponent)
  if (!d) seen.set(r.opponent, (d = new Set()))
  d.add(r.date)
}
for (const [t, d] of seen) out.games[t] = d.size
const round = (x: { min: number; s: Record<string, number> }) => ({ min: Math.round(x.min), s: Object.fromEntries(Object.entries(x.s).map(([k, v]) => [k, Math.round(v)])) })
console.log(JSON.stringify({
  season, source: 'Sleeper weekly game logs', built: new Date().toISOString().slice(0, 10),
  league: Object.fromEntries(Object.entries(out.league).map(([k, v]) => [k, round(v)])),
  teams: Object.fromEntries(Object.entries(out.teams).sort().map(([k, v]) => [k, round(v)])),
  games: out.games,
}, null, 1))
