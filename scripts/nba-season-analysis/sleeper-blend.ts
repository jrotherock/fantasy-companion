/**
 * Sleeper's game projections alone (weight 1, as the app ran until 2026-10-23) against half Sleeper, half the
 * companion's own line (0.5), on one league as it stands: this week's projected result, the Adds verdict and
 * top moves, and my players' lines for the rest of the week.
 *
 *   [NOW=<iso>] [TEAMS=<n>] npx tsx scripts/nba-season-analysis/sleeper-blend.ts <snapshot dir> <league id> <today> <scores> [proj.json] [stats.json] [sleeper players.json]
 *
 * <scores> is my matchup's two sides as read from Yahoo's scoreboard: "teamId|points|statId=value ..." twice, joined
 * by "//". The Sleeper files are week projections (/projections/nba/2026/<w>), week stats (/stats/nba/2026/<w>) and
 * the player file (/v1/players/nba), saved beforehand.
 */
import { readFileSync, existsSync } from 'node:fs'
import { Context, type World, type Snapshot } from '../../src/nba/inseason.js'
import { buildSeasonView } from '../../src/nba/seasonView.js'
import { applyAdjustments, resolvePreferences } from '../../src/nba/preferences.js'
import { NameIndex } from '../../src/nba/join.js'
import { boxOf, emptyBox, type NbaMatchup, type TeamMeta } from '../../src/nba/yahooSeason.js'
import { parseSleeperDayProjections, parseSleeperLogs } from '../../src/nba/outlook.js'
import { daysFrom } from '../../src/nba/week.js'
import { addDays } from '../../src/nba/adds.js'
import type { YPlayer } from '../../src/server/yahooParse.js'
import type { YahooWeek } from '../../src/nba/types.js'

const [S, LEAGUE, TODAY, SCORES, PROJ, STATS, SPLAYERS] = process.argv.slice(2)
// NOW (an ISO instant) for a late-night run: an add made then counts from the next day.
const NOW = process.env.NOW ? Date.parse(process.env.NOW) : Date.parse(TODAY + 'T16:00:00Z')
const rawPlayers = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players as any[]
const prefs = existsSync('data/preferences/nba.json') ? JSON.parse(readFileSync('data/preferences/nba.json', 'utf8')) : null
const index = new NameIndex(rawPlayers.map((p) => ({ id: p.id, name: p.name, team: p.team })))
const live: Record<string, any> = SPLAYERS ? JSON.parse(readFileSync(SPLAYERS, 'utf8')) : {}
// Today's team and designation from Sleeper's file, as the server does (a released player has none).
const players = applyAdjustments(rawPlayers, resolvePreferences(prefs, LEAGUE, index).adjust).map((p: any) => {
  const l = live[p.id]
  if (!l || !(l.team || l.injury_status || l.active)) return p
  return { ...p, team: l.team ?? null, injury: l.injury_status ? { status: l.injury_status, body: null, notes: null } : null }
})
const schedule = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8'))
const sdWeekly = Object.fromEntries(Object.entries(noise.raw).map(([k, v]: [string, any]) => [k, v.sdWeekly])) as any
const row = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === LEAGUE)
const d = JSON.parse(readFileSync(`${S}/sched.json`, 'utf8'))
const ME = SCORES.split('//')[0].split('|')[0]
const league = { ...row, teams: Number(process.env.TEAMS ?? row.teams), adds: row.adds ?? { perWeek: null, season: null }, myTeamId: ME }
const byY = new Map(players.filter((p: any) => p.yahoo).map((p: any) => [p.yahoo.yahooId, p]))

const meta = (id: string, name: string): TeamMeta => ({ key: `${row.leagueKey}.t.${id}`, id, name, manager: name, mine: id === ME, addsThisWeek: 0, moves: 0, waiverPriority: null, faab: null })
const ypl = (p: any, slot: string): YPlayer => ({
  key: `478.p.${p.yahoo.yahooId}`, yahooId: p.yahoo.yahooId, name: p.name, display: (p.yahoo.positions ?? p.positions).join(','),
  primary: p.positions[0] ?? null, eligible: [...(p.yahoo.positions ?? p.positions), 'Util'], team: p.team, status: p.injury?.status ?? null,
  injury: null, slot, points: null, byeWeek: null,
})
const fixtures = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); return { week: +w, start: a, end: b, pairs: pairs.split(',').map((x: string) => x.split('-')) } })
const rosters = d.rosters.split('\n').map((line: string) => {
  const [tid, name, list] = line.split('~')
  return { team: meta(tid, tid === ME ? 'Me' : `Team ${tid}`), players: list.split(',').map((y: string) => ({ y: y.replace('i', ''), il: y.endsWith('i') })).filter((x: any) => byY.has(x.y)).map((x: any) => ypl(byY.get(x.y), x.il ? 'IL' : 'BN')) }
})
const sides = SCORES.split('//').map((s) => {
  const [tid, pts, stats] = s.split('|')
  const box = boxOf(stats.split(' ').map((kv) => { const [stat_id, value] = kv.split('='); return { stat: { stat_id, value } } }))
  return { ...rosters.find((r: any) => r.team.id === tid)!.team, box, points: Number(pts), projected: null, games: null }
})
const f1 = fixtures[0]
const scoreboard: NbaMatchup[] = f1.pairs.map(([a, b]: string[]) => ({
  week: 1, start: f1.start, end: f1.end, status: 'midevent', playoffs: false, consolation: false, winnerTeamId: null, leaders: {},
  sides: [a, b].map((t) => sides.find((x) => x.id === t) ?? { ...rosters.find((r: any) => r.team.id === t)!.team, box: emptyBox(), points: 0, projected: null, games: null }),
}))
const snap: Snapshot = {
  at: NOW,
  settings: { maxAdds: null, maxWeeklyAdds: league.adds.perWeek, tradeEnd: null, playoffStartWeek: row.playoffWeeks?.[0] ?? 20, playoffTeams: 6, waiverType: 'R', waiverDays: 2, faab: false, scoringType: 'head' } as any,
  weeks: fixtures.map((f: any) => [f.week, f.start, f.end] as YahooWeek), rosters, mineToday: null, scoreboard, past: {}, standings: [], waivers: [], transactions: [], fixtures,
}
const dayProj = PROJ ? parseSleeperDayProjections(JSON.parse(readFileSync(PROJ, 'utf8'))) : new Map()
const logs = STATS ? parseSleeperLogs(JSON.parse(readFileSync(STATS, 'utf8'))) : []
// RETURNS="Name:YYYY-MM-DD;…": return dates, as set on the screen (preferences `returns`).
const returns = new Map((process.env.RETURNS ?? '').split(';').filter(Boolean).map((x) => { const [n, d] = x.split(':'); return [players.find((p: any) => p.name === n)!.id, d] as [string, string] }))
const world = (w: number): World => ({ players, logs, dayProj, sleeperWeight: w, injuries: [], returns, schedule, noise: { sdWeekly }, never: new Set(), now: NOW, today: TODAY })

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const fpw = league.scoring === 'points' ? league.points : null
const fp = (b: any) => Object.entries(fpw ?? {}).reduce((s, [k, w]) => s + (w as number) * (b[k] ?? 0), 0)
const out: Record<string, string[]> = {}
// PUNTS="ast" compares the league without punts and with them instead, both on the averaged lines.
const PUNTS = (process.env.PUNTS ?? '').split(',').filter(Boolean)
const cases = PUNTS.length
  ? [{ key: 'a', w: 0.5, punts: [], label: 'BEFORE: every category counted' }, { key: 'b', w: 0.5, punts: PUNTS, label: `AFTER: punting ${PUNTS.join(', ')}` }]
  : [{ key: 'a', w: 1, punts: [], label: 'BEFORE: Sleeper alone' }, { key: 'b', w: 0.5, punts: [], label: 'AFTER: half Sleeper, half own' }]
const runs = cases.map(({ key, w, punts }) => {
  const v = buildSeasonView({ ...league, punts } as any, snap, world(w))
  const lines: string[] = []
  const wk = v.week
  if (wk?.points) lines.push(`week: ${wk.points.mine.toFixed(0)}–${wk.points.theirs.toFixed(0)} projected, win ${pct(wk.points.win)}`)
  if (wk?.odds) lines.push(`week: win ${pct(wk.odds.win)} · ${wk.odds.races.map((r) => `${r.cat} ${pct(r.win)}`).join(' ')}`)
  for (const r of v.ilBack) lines.push(r.ready ? `off IL first: ${r.name} (${r.status}) for ${r.dropName ?? 'an open spot'}, season ${r.seasonWins?.toFixed(2)}` : `due back ${r.returns}: ${r.name} (${r.status})`)
  const wv = v.weekVerdict
  if (wv) lines.push(`WEEK (${wv.chance}): ${wv.level} — ${wv.headline} · ${Math.round(wv.winBefore * 100)}% → ${Math.round(wv.winAfter * 100)}%${wv.season != null ? ` · season ${wv.season.toFixed(2)}` : ''}${wv.aligned ? ' · ALIGNED with season' : ''}${wv.races.length ? ' · ' + wv.races.map((r) => `${r.cat} ${Math.round(r.before * 100)}→${Math.round(r.after * 100)}`).join(' ') : ''}${wv.moves.length ? ' · ' + wv.moves.map((m) => `${m.name} from ${m.from.slice(5)}${m.seasonWins != null ? ` (${m.seasonWins.toFixed(2)})` : ''}`).join(', ') : ''}`)
  if (v.ilSwap) for (const o of v.ilSwap.options) lines.push(`IL swap: drop ${o.dropName} (back ${o.dropBack ?? '?'}), ${o.toIlName} to IL, add ${o.name}: season ${o.seasonWins.toFixed(2)}`)
  const vd = v.verdict
  lines.push(`verdict: ${vd ? `${vd.level} — ${vd.headline} (${vd.when}; season ${vd.season?.toFixed(2)}${vd.confidence ? `, holds ${vd.confidence.holds}/${vd.confidence.of}` : ''})` : 'none'}`)
  for (const p of v.pickups.slice(0, Number(process.env.TOP ?? 6))) {
    const wkx = p.weekGain == null ? '' : fpw ? `${p.weekGain >= 0 ? '+' : ''}${p.weekGain.toFixed(1)} pts` : `${p.weekGain >= 0 ? '+' : ''}${Math.round(p.weekGain * 100)}pp`
    lines.push(`  ${p.kind.padEnd(7)} ${p.name} for ${p.dropName ?? '—'}: week ${wkx}, season ${p.seasonWins?.toFixed(2) ?? '—'}`)
  }
  out[key] = lines
  return { v, w }
})
console.log(`${row.label ?? LEAGUE} — ${TODAY}`)
for (const c of cases) { console.log(`\n[${c.label}]`); for (const l of out[c.key]) console.log(l) }
// COMPARE="Name,Name": each added into an open spot from tomorrow (the roster as the snapshot has it), this week's
// chance and each race, with the averaged lines.
if (process.env.COMPARE) {
  const { scoreWeek } = await import('../../src/nba/adds.js')
  const { sideOutlook, rosterIds } = await import('../../src/nba/inseason.js')
  const { startingSeats: seatsOf } = await import('../../src/nba/week.js')
  const ctx = new Context({ ...league, punts: PUNTS } as any, world(0.5))
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) ctx.setStatus(id, y.status) }
  const seats = seatsOf(league.roster)
  const m = snap.scoreboard.find((x) => x.sides.some((sd) => sd.id === ME))!
  const mine = m.sides.find((sd) => sd.id === ME)!, theirs = m.sides.find((sd) => sd.id !== ME)!
  const allDays = daysFrom(f1.start, f1.end, TODAY), tomorrow = addDays(TODAY, 1)
  const opp = sideOutlook(ctx, theirs as any, rosterIds(ctx, rosters.find((r: any) => r.team.id === theirs.id)!.players), seats, allDays).side
  const myIds = rosterIds(ctx, rosters.find((r: any) => r.team.id === ME)!.players)
  const show = (label: string, men: any[]) => { const r = scoreWeek(ctx, mine as any, opp, theirs as any, seats, allDays, men); console.log(`${label.padEnd(22)} week ${Math.round(r.win * 100)}%  ${(r.races ?? []).map((x) => `${x.cat} ${Math.round(x.win * 100)}`).join(' ')}`) }
  const base = myIds.map((x) => ({ ...x, from: allDays[0], until: null }))
  show('as is', base)
  for (const n of process.env.COMPARE.split(',')) {
    const p = players.find((x: any) => x.name === n)!
    show(`+ ${n}`, [...base, { id: p.id, eligible: p.positions, from: tomorrow, until: null }])
  }
}
if (PUNTS.length) process.exit(0)

// My players' lines for the rest of the week, game by game, both ways.
const days = daysFrom(f1.start, f1.end, TODAY)
const mine = rosters.find((r: any) => r.team.id === ME)!.players.filter((y: YPlayer) => y.slot !== 'IL')
const ctxs = [1, 0.5].map((w) => new Context(league, world(w)))
console.log(`\nMy players, ${days[0]}..${days[days.length - 1]}: ${fpw ? 'fantasy points' : 'pts/reb/ast/3s/stl/blk'} a game, before → after`)
for (const y of mine) {
  const id = ctxs[0].resolve(y)
  if (!id) continue
  const cells: string[] = []
  for (const day of days) {
    const team = ctxs[0].byId.get(id)?.team
    if (!schedule.some((g: any) => g.date === day && (g.home === team || g.away === team))) continue
    const [a, b] = ctxs.map((c) => c.outlook(id, day)!.box)
    const sl = dayProj.get(`${id}|${day}`)
    const say = (x: any) => (fpw ? fp(x).toFixed(1) : `${x.pts.toFixed(0)}/${x.reb.toFixed(0)}/${x.ast.toFixed(0)}/${x.tpm.toFixed(1)}/${x.stl.toFixed(1)}/${x.blk.toFixed(1)}`)
    cells.push(`${day.slice(5)} ${say(a)} → ${say(b)}${sl ? '' : ' (no Sleeper line)'}`)
  }
  if (cells.length) console.log(`  ${y.name.padEnd(22)} ${cells.join(' · ')}`)
}
void addDays
