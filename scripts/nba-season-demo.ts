/**
 * A made-up mid-season snapshot for a -test basketball league, so the season
 * screens can be looked at before the season starts.
 *
 *   npx tsx scripts/nba-season-demo.ts nba-hoops-test 2026-11-18 http://localhost:4603
 *
 * The league is drafted by Yahoo ADP, the week's box lines so far are scaled
 * from projections, past weeks are drawn at random around them, and two of my
 * starters are given designations so the news and lineup screens have
 * something to say. The server only takes this for leagues ending in -test.
 * Run it with NBA_NOW set on the server to the same day (see .claude/launch.json).
 * A fourth argument, an ISO instant, gives my players whose games tipped by then
 * a box line, as Yahoo's would read mid-game (the nba-test-live server).
 */
import { readFileSync } from 'node:fs'
import type { NbaPlayer, Game } from '../src/nba/types.js'
import { emptyBox, type Box, type NbaMatchup, type TeamMeta } from '../src/nba/yahooSeason.js'
import { perGameBox } from '../src/nba/outlook.js'

const [leagueId = 'nba-hoops-test', today = '2026-11-18', base = 'http://localhost:4603', liveAt] = process.argv.slice(2)
if (!leagueId.endsWith('-test')) throw new Error('only -test leagues')

const players: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const schedule: Game[] = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games
const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
const real = leagues.find((l: any) => l.id === leagueId.replace(/-test$/, ''))
const teams: number = real.teams
const myId: string = real.myTeamId
const rounds = Object.entries(real.roster as Record<string, number>).filter(([s]) => s !== 'IL').reduce((n, [, c]) => n + c, 0)

let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const weeks = Array.from({ length: 24 }, (_, i) => {
  const s = new Date(Date.UTC(2026, 9, 19 + 7 * i)), e = new Date(Date.UTC(2026, 9, 25 + 7 * i))
  return [i + 1, i === 0 ? '2026-10-20' : s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)] as [number, string, string]
})
const current = weeks.find(([, s, e]) => s <= today && today <= e)!

const pool = players.filter((p) => p.yahoo && p.projection && p.team).sort((a, b) => (a.yahoo!.adp ?? 999) - (b.yahoo!.adp ?? 999))
const rosters: NbaPlayer[][] = Array.from({ length: teams }, () => [])
let k = 0
for (let r = 0; r < rounds; r++) for (const t of r % 2 ? [...rosters.keys()].reverse() : [...rosters.keys()]) rosters[t].push(pool[k++])

const names = ['Huff Huff Pass', 'Beats by Dray', 'Wemby Wonderland', 'Slim Reaper Kats', 'Tatum Tots', 'Brunson Burners', 'Kawhi Not', 'Jokic Joke', 'Dame Time', 'Bam Squad', 'Shai Me Up Domo Down', 'Luka Warm', 'Zion Lion', 'Giannis Gang', 'Mobley Dick', 'Haliburton Ernie']
const meta = (i: number): TeamMeta => {
  const id = String(i + 1), mine = id === myId
  return { key: `${real.leagueKey}.t.${id}`, id, name: mine ? real.myTeamName : names[i % names.length] === real.myTeamName ? `Team ${id}` : names[i % names.length], manager: mine ? 'Justin' : `Manager ${id}`, mine, addsThisWeek: mine ? 3 : Math.floor(rand() * 5), moves: mine ? 31 : Math.floor(20 + rand() * 30), waiverPriority: i + 1, faab: null }
}

const seats = ['PG', 'SG', 'SF', 'PF', 'C', ...Array(real.roster.Util).fill('Util')]
const ypl = (p: NbaPlayer, slot: string, status: string | null = null) => ({
  key: `478.p.${p.yahoo?.yahooId ?? p.id}`, yahooId: p.yahoo?.yahooId ?? `x${p.id}`, name: p.name, display: p.positions.join(','),
  primary: p.positions[0] ?? null, eligible: [...p.positions, 'Util'], team: p.team, status, injury: null, slot, points: null, byeWeek: null,
})
// Seat as drafted, ignoring the schedule: what a careless manager leaves in place.
const seated = (ps: NbaPlayer[]) => ps.map((p, i) => ypl(p, seats[i] ?? 'BN'))

const mineIdx = Number(myId) - 1
const statuses: Record<string, string> = {}
statuses[rosters[mineIdx][2].id] = 'O'
statuses[rosters[mineIdx][5].id] = 'GTD'

const teamsRows = rosters.map((ps, i) => ({ team: meta(i), players: seated(ps).map((y, j) => ({ ...y, status: i === mineIdx ? statuses[ps[j].id] ?? null : null })) }))

const scale = (b: Box, k: number): Box => Object.fromEntries(Object.entries(b).map(([s, v]) => [s, Math.round(v * k)])) as unknown as Box
const weekBox = (ps: NbaPlayer[], days: number, noise = 0.15) => {
  let out = emptyBox()
  for (const p of ps.slice(0, rounds - 3)) {
    const b = perGameBox(p)
    for (const s of Object.keys(out) as (keyof Box)[]) out[s] += b[s] * (days / 7) * 3.5 * (1 + (rand() - 0.5) * 2 * noise)
  }
  return scale(out, 1)
}

const pairs = (w: number) => {
  const ids = [...Array(teams).keys()]
  const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w) % (teams - 1))])]
  return Array.from({ length: teams / 2 }, (_, i) => [rot[i], rot[teams - 1 - i]] as [number, number])
}
const side = (i: number, box: Box, points: number | null) => ({ ...meta(i), box, points, projected: null, games: null })
const catsWon = (a: Box, b: Box) => {
  const ca = { fg: a.fgm / a.fga, ft: a.ftm / a.fta, tpm: a.tpm, pts: a.pts, reb: a.reb, ast: a.ast, stl: a.stl, blk: a.blk, to: -a.to }
  const cb = { fg: b.fgm / b.fga, ft: b.ftm / b.fta, tpm: b.tpm, pts: b.pts, reb: b.reb, ast: b.ast, stl: b.stl, blk: b.blk, to: -b.to }
  return Object.keys(ca).filter((c) => (ca as any)[c] > (cb as any)[c]).length
}
const fp = (b: Box) => b.pts + 1.2 * b.reb + 1.5 * b.ast + 3 * b.stl + 3 * b.blk - b.to
const matchup = (w: number, days: number, status: string): NbaMatchup[] => pairs(w).map(([a, b]) => {
  const ba = weekBox(rosters[a], days), bb = weekBox(rosters[b], days)
  const cats = real.scoring === 'categories'
  const [wk, s, e] = weeks[w - 1]
  return {
    week: wk, start: s, end: e, status, playoffs: false, consolation: false, winnerTeamId: null, leaders: {},
    sides: [side(a, ba, cats ? catsWon(ba, bb) : Math.round(fp(ba))), side(b, bb, cats ? catsWon(bb, ba) : Math.round(fp(bb)))],
  }
})

const past: Record<number, NbaMatchup[]> = {}
for (let w = 1; w < current[0]; w++) past[w] = matchup(w, 7, 'postevent')
const daysIn = Math.round((Date.parse(today) - Date.parse(current[1])) / 86400000)
const scoreboard = matchup(current[0], daysIn, 'midevent')

const standings = rosters.map((_, i) => {
  let w = 0, l = 0
  for (const ms of Object.values(past)) for (const m of ms) {
    const me = m.sides.find((s) => s.id === String(i + 1)), them = m.sides.find((s) => s.id !== String(i + 1))
    if (!me || !them || !m.sides.includes(me)) continue
    if ((me.points ?? 0) > (them.points ?? 0)) w++; else l++
  }
  return { teamId: String(i + 1), name: meta(i).name, manager: meta(i).manager, mine: String(i + 1) === myId, rank: 0, wins: w, losses: l, ties: 0, pointsFor: null, pointsAgainst: null, rankWeek: null, pointsWeek: null, projectedWeek: null, fromChop: null, faab: null }
}).sort((a, b) => b.wins - a.wins).map((s, i) => ({ ...s, rank: i + 1 }))

const owned = new Set(rosters.flat().map((p) => p.id))
const waivers = players.filter((p) => p.yahoo && !owned.has(p.id)).slice(0, 4).map((p) => p.yahoo!.yahooId)
const now = Date.parse(today + 'T20:00:00Z')
const statusEvents = Object.entries(statuses).map(([id, s], i) => ({ id, at: now - (i + 1) * 3600000, from: 'healthy', to: s === 'O' ? 'out' : 'questionable' }))

/** Part of a game's line for a player whose game has tipped: Yahoo's box so far. */
function liveBox(p: NbaPlayer): Box | null {
  if (!liveAt) return null
  const g = schedule.find((x) => x.date === today && x.tip && (x.home === p.team || x.away === p.team))
  if (!g || Date.parse(g.tip!) > Date.parse(liveAt)) return null
  const share = Math.min(1, (Date.parse(liveAt) - Date.parse(g.tip!)) / (2.4 * 3600000))
  return scale(perGameBox(p), share * (0.6 + rand() * 0.8))
}

const snap = {
  settings: { maxAdds: real.adds.season, maxWeeklyAdds: real.adds.perWeek, tradeEnd: '2027-02-04', playoffStartWeek: real.playoffWeeks[0], playoffTeams: real.playoffTeams, waiverType: 'R', waiverDays: 2, faab: real.scoring === 'points', scoringType: 'head' },
  weeks, rosters: teamsRows,
  mineToday: { team: meta(mineIdx), date: today, players: teamsRows[mineIdx].players.map((y, j) => ({ ...y, box: liveBox(rosters[mineIdx][j]) })) },
  scoreboard, past, standings, waivers, transactions: [], statusEvents,
}

const res = await fetch(`${base}/api/nba/season/${leagueId}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap) })
const v = await res.json()
console.log(res.status, v.error ?? `${v.phase}: week ${v.week?.week}, ${v.lineup?.moves.length} lineup moves, ${v.pickups?.length} pickups, ${v.news?.length} news, ${v.trades?.length} trades`)
