/**
 * Real minutes against projected minutes, once teams have played: each player's minutes so far this week (Sleeper's
 * game logs), beside the companion's projection (with your own minutes where set, data/preferences/nba.json) and
 * Josh Lloyd's 240-game call (lloyd-240-2026-10-18.json). Players on any of my three rosters, players named, and any
 * ranked player whose real minutes run 4+ from the projection.
 *
 *   npx tsx scripts/nba-season-analysis/minutes-check.ts [week=1] ["Name,Name"]
 */
import { readFileSync } from 'node:fs'
import { applyAdjustments, resolvePreferences } from '../../src/nba/preferences.js'
import { NameIndex } from '../../src/nba/join.js'

const WEEK = Number(process.argv[2] ?? 1)
const NAMED = (process.argv[3] ?? 'DeMar DeRozan').split(',').filter(Boolean)
const raw = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const prefs = JSON.parse(readFileSync('data/preferences/nba.json', 'utf8'))
const index = new NameIndex(raw.map((p) => ({ id: p.id, name: p.name, team: p.team })))
// Every league's minutes, the shared ones: what the projection is after your settings.
const players = applyAdjustments(raw, resolvePreferences({ ...prefs, leagues: {} }, 'none', index).adjust)
const P = new Map(players.map((p: any) => [p.id, p]))
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.']/g, '')
const lloyd = new Map(Object.entries(JSON.parse(readFileSync('scripts/nba-season-analysis/lloyd-240-2026-10-18.json', 'utf8')).minutes).map(([n, m]) => [fold(n), m as number]))
const res = await fetch(`https://api.sleeper.app/stats/nba/2026/${WEEK}?season_type=regular`)
const rows = (await res.json()) as any[]
const games = new Map<string, number[]>()
for (const r of rows) {
  const sp = Number(r?.stats?.sp ?? 0)
  if (!r?.player_id || !(sp > 0)) continue
  ;(games.get(String(r.player_id)) ?? games.set(String(r.player_id), []).get(String(r.player_id))!).push(sp / 60)
}
const mine = new Map<string, string[]>()
for (const [label, dir] of [['Hoops', '2026-10-21-hoops'], ['Harker', '2026-10-19-harker'], ['Public', '2026-10-19-public']] as const) {
  const d = JSON.parse(readFileSync(`scripts/nba-season-analysis/${dir}/sched.json`, 'utf8'))
  const me = { Hoops: '4', Harker: '3', Public: '2' }[label]
  const line = d.rosters.split('\n').find((l: string) => l.startsWith(me + '~'))
  for (const y of line.split('~').pop().split(',')) {
    const p = players.find((x: any) => x.yahoo?.yahooId === y.replace('i', ''))
    if (p) (mine.get(p.id) ?? mine.set(p.id, []).get(p.id)!).push(label)
  }
}
const teamsPlayed = new Set(rows.filter((r) => Number(r?.stats?.sp ?? 0) > 0).map((r) => r.team))
const out: any[] = []
for (const [id, ms] of games) {
  const p: any = P.get(id)
  if (!p?.projection) continue
  const real = ms.reduce((a, b) => a + b, 0) / ms.length
  const proj = p.projection.perGame.min
  const l = lloyd.get(fold(p.name)) ?? null
  const named = NAMED.includes(p.name)
  const rank = p.yahoo?.rank ?? 999
  if (!mine.has(id) && !named && !(rank <= 200 && Math.abs(real - proj) >= 4)) continue
  out.push({ name: p.name, team: p.team, gp: ms.length, real, proj, l, d: real - proj, mine: mine.get(id) ?? [], named, rank })
}
out.sort((a, b) => Number(b.named) - Number(a.named) || Number(b.mine.length > 0) - Number(a.mine.length > 0) || Math.abs(b.d) - Math.abs(a.d))
console.log(`Week ${WEEK}: ${teamsPlayed.size} of 30 teams have played. Real minutes a game so far vs the companion's projection (your settings in) and Josh's call.`)
console.log('player'.padEnd(24), 'team', 'gp', ' real', ' proj', 'josh', '  diff', ' rosters')
for (const r of out) console.log(`${(r.named ? '* ' : '') + r.name}`.padEnd(24), (r.team ?? '').padEnd(4), String(r.gp).padStart(2), r.real.toFixed(1).padStart(5), r.proj.toFixed(1).padStart(5), (r.l ?? '—').toString().padStart(4), `${r.d >= 0 ? '+' : ''}${r.d.toFixed(1)}`.padStart(6), ' ' + r.mine.join(','))
const missing = NAMED.filter((n) => !out.some((r) => r.name === n))
if (missing.length) console.log('Not played yet:', missing.join(', '))
