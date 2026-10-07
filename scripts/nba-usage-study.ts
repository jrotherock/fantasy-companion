/**
 * Do roster moves squeeze the players who stay — and do the projections know?
 *
 * The 240 check shows how many plays a game each team's moves added or freed
 * (teamLoad.ts: arrivals' last-season plays less departures', movers with 12+
 * points a game). This asks whether that number has meant anything:
 *
 *   1. History, 2018-19 to 2024-25. For every player who stayed on his team
 *      (20+ games both seasons, 20+ minutes the first), how his plays, points,
 *      minutes and fantasy points a game changed, against his team's net plays,
 *      allowing for his level the year before (regression to the mean) and his
 *      age. The slope on net plays is the squeeze a real season delivered.
 *   2. This year's projections, the same regression on projected-minus-last-
 *      season for this year's incumbents. If the projections' slope is close to
 *      history's, they already price roster moves in; if flatter, they do not.
 *
 * Plays are shots, trips to the line (0.44 a free throw) and turnovers. Error
 * bars are a bootstrap over team-seasons, since teammates share one shock.
 *
 *   npx tsx scripts/nba-usage-study.ts <dir with stats-YYYY.json from Sleeper>
 */
import { readFileSync } from 'node:fs'

const DIR = process.argv[2]
if (!DIR) throw new Error('usage: nba-usage-study.ts <dir with stats-YYYY.json>')
const sleeper = JSON.parse(readFileSync('data/nba/raw/sleeper-players.json', 'utf8'))
const W: Record<string, number> = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 }
const MOVER_PTS = 12

type Line = { team: string | null; gp: number; min: number; plays: number; pts: number; fp: number; tpm: number; ast: number }
const lineOf = (s: any, team: string | null): Line | null => {
  const gp = s?.gp ?? 0
  if (!gp) return null
  const per = (k: string) => (s[k] ?? 0) / gp
  return {
    team, gp, min: (s.sp ?? 0) / 60 / gp,
    plays: per('fga') + 0.44 * per('fta') + per('to'),
    pts: per('pts'), tpm: per('tpm'), ast: per('ast'),
    fp: Object.entries(W).reduce((a, [k, w]) => a + w * per(k), 0),
  }
}
const seasons: Record<number, Map<string, Line>> = {}
for (let y = 2018; y <= 2025; y++) {
  const d = JSON.parse(readFileSync(`${DIR}/stats-${y}.json`, 'utf8'))
  const m = new Map<string, Line>()
  for (const x of (Array.isArray(d) ? d : Object.values(d)) as any[]) {
    if (!x?.player_id || !x.stats) continue
    const l = lineOf(x.stats, x.team ?? null)
    if (l) m.set(x.player_id, l)
  }
  seasons[y] = m
}
const ageIn = (pid: string, y: number): number | null => {
  const b = sleeper[pid]?.birth_date
  return b ? y - Number(b.slice(0, 4)) - (Number(b.slice(5, 7)) >= 10 ? 1 : 0) : null
}

interface Row { group: string; net: number; prev: Line; next: { plays: number; pts: number; fp: number; min: number; tpm: number; ast: number }; age: number }

/** Net plays a game each team's moves added: arrivals' last-season plays less departures'. */
function netPlays(moves: { from: string | null; to: string | null; last: Line }[]): Map<string, number> {
  const net = new Map<string, number>()
  for (const m of moves) {
    if (m.last.gp < 20 || m.last.pts < MOVER_PTS || m.from === m.to) continue
    if (m.to) net.set(m.to, (net.get(m.to) ?? 0) + m.last.plays)
    if (m.from) net.set(m.from, (net.get(m.from) ?? 0) - m.last.plays)
  }
  return net
}

// ── 1. History ──
const hist: Row[] = []
for (let y = 2019; y <= 2025; y++) {
  const prev = seasons[y - 1], now = seasons[y]
  const net = netPlays([...prev.entries()].map(([pid, l]) => ({ from: l.team, to: now.get(pid)?.team ?? null, last: l })))
  for (const [pid, p] of prev) {
    const n = now.get(pid)
    if (!n || !p.team || p.team !== n.team || p.gp < 20 || n.gp < 20 || p.min < 20) continue
    const age = ageIn(pid, y)
    if (age == null) continue
    hist.push({ group: `${y}:${p.team}`, net: net.get(p.team) ?? 0, prev: p, next: n, age })
  }
}

// ── 2. This year's projections ──
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const lastOf = (p: any): Line | null => {
  const h = p.history?.at(-1)
  if (!h || h.season !== 2025) return null
  const g = h.perGame, s = h.shooting ?? {}
  return { team: h.team, gp: h.gp, min: g.min, plays: (s.fga ?? 0) + 0.44 * (s.fta ?? 0) + (g.to ?? 0), pts: g.pts, tpm: g.tpm, ast: g.ast, fp: Object.entries(W).reduce((a, [k, w]) => a + w * (g[k] ?? 0), 0) }
}
const projNet = netPlays(players.filter((p) => p.team && lastOf(p)).map((p) => ({ from: lastOf(p)!.team, to: p.team, last: lastOf(p)! })))
const proj: Row[] = []
for (const p of players) {
  const last = lastOf(p), pr = p.projection
  if (!last || !pr || !p.team || last.team !== p.team || last.gp < 20 || last.min < 20 || p.age == null) continue
  const g = pr.perGame, s = pr.shooting ?? {}
  proj.push({
    group: `2026:${p.team}`, net: projNet.get(p.team) ?? 0, prev: last, age: p.age,
    next: { plays: (s.fga ?? 0) + 0.44 * (s.fta ?? 0) + (g.to ?? 0), pts: g.pts, tpm: g.tpm, ast: g.ast, min: g.min, fp: Object.entries(W).reduce((a, [k, w]) => a + w * (g[k] ?? 0), 0) },
  })
}

// ── Least squares: change = a + b·net + c·last-season level + d·(age over 28) + e·(age under 24) ──
function ols(X: number[][], y: number[]): number[] {
  const k = X[0].length
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (j < k ? X.reduce((s, r) => s + r[i] * r[j], 0) : X.reduce((s, r, n) => s + r[i] * y[n], 0))))
  for (let c = 0; c < k; c++) {
    const p = A.reduce((best, r, i) => (i >= c && Math.abs(r[c]) > Math.abs(A[best][c]) ? i : best), c);
    [A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j] }
  }
  return A.map((r, i) => r[k] / r[i])
}
type Key = 'plays' | 'pts' | 'fp' | 'min' | 'tpm' | 'ast'
const design = (r: Row, key: Key) => [1, r.net, r.prev[key], Math.max(0, r.age - 28), Math.max(0, 24 - r.age)]
function slope(rows: Row[], key: Key): number {
  return ols(rows.map((r) => design(r, key)), rows.map((r) => r.next[key] - r.prev[key]))[1]
}
let seed = 7
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
function boot(rows: Row[], key: Key, n = 400): { b: number; lo: number; hi: number } {
  const groups = [...new Set(rows.map((r) => r.group))]
  const by = new Map(groups.map((g) => [g, rows.filter((r) => r.group === g)]))
  const bs: number[] = []
  for (let i = 0; i < n; i++) {
    const sample = Array.from({ length: groups.length }, () => by.get(groups[Math.floor(rand() * groups.length)])!).flat()
    bs.push(slope(sample, key))
  }
  bs.sort((a, b) => a - b)
  return { b: slope(rows, key), lo: bs[Math.floor(n * 0.025)], hi: bs[Math.floor(n * 0.975)] }
}

const fmt = (x: { b: number; lo: number; hi: number }) => `${(x.b * 10 >= 0 ? '+' : '')}${(x.b * 10).toFixed(2)} [${(x.lo * 10).toFixed(2)}, ${(x.hi * 10).toFixed(2)}]`
console.log(`History: ${hist.length} incumbent seasons on ${new Set(hist.map((r) => r.group)).size} team-seasons. Projections: ${proj.length} incumbents.`)
console.log('Change a game for an incumbent, per +10 net plays his team took on (95% interval):')
console.log('                 history (real seasons)          this year\'s projections')
for (const [key, label] of [['plays', 'plays'], ['pts', 'points'], ['fp', 'fantasy pts'], ['min', 'minutes'], ['tpm', 'threes'], ['ast', 'assists']] as [Key, string][]) {
  console.log(`  ${label.padEnd(12)}  ${fmt(boot(hist, key)).padEnd(32)}  ${fmt(boot(proj, key))}`)
}
// How big moves get: the spread of net plays, so a slope can be read as a typical effect.
const nets = [...new Set(hist.map((r) => `${r.group}|${r.net}`))].map((s) => Number(s.split('|')[1])).sort((a, b) => a - b)
console.log(`\nTeam net plays in history: 10th pct ${nets[Math.floor(nets.length * 0.1)].toFixed(0)}, median ${nets[Math.floor(nets.length / 2)].toFixed(0)}, 90th pct ${nets[Math.floor(nets.length * 0.9)].toFixed(0)}. This year: ${[...projNet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} +${n.toFixed(0)}`).join(', ')}`)

// ── The lead ball-handlers: is the squeeze concentrated on the players with the most to give up? ──
const STAR = 18
const stars = (rows: Row[]) => rows.filter((r) => r.prev.plays >= STAR)
console.log(`\nHigh-usage incumbents only (${STAR}+ plays a game last season): history ${stars(hist).length}, projections ${stars(proj).length}`)
for (const [key, label] of [['plays', 'plays'], ['pts', 'points'], ['fp', 'fantasy pts'], ['tpm', 'threes'], ['ast', 'assists']] as [Key, string][]) {
  console.log(`  ${label.padEnd(12)}  ${fmt(boot(stars(hist), key)).padEnd(32)}  ${fmt(boot(stars(proj), key))}`)
}
// As a share of his own load: change in plays over last season's plays.
// The change in plays as a share of last season's, keeping last season's level as the control.
const pctRows = (rows: Row[]) => rows.map((r) => ({ ...r, next: { ...r.next, plays: r.prev.plays + (r.next.plays / r.prev.plays - 1) } }))
const pb = (rows: Row[]) => { const x = boot(pctRows(rows) as Row[], 'plays'); return `${(x.b * 1000).toFixed(1)}% [${(x.lo * 1000).toFixed(1)}, ${(x.hi * 1000).toFixed(1)}]` }
console.log(`\nAs a share of his own plays, per +10 net plays: all incumbents ${pb(hist)} (history) vs ${pb(proj)} (projections); high-usage ${pb(stars(hist))} vs ${pb(stars(proj))}`)
const maxey = proj.find((r) => r.group === '2026:PHI' && r.prev.plays > 20)
if (maxey) console.log(`Philadelphia's lead guard: net ${maxey.net.toFixed(0)} plays; last season ${maxey.prev.plays.toFixed(1)} plays, ${maxey.prev.pts.toFixed(1)} pts → projected ${maxey.next.plays.toFixed(1)}, ${maxey.next.pts.toFixed(1)}`)
