import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { YPlayer } from '../server/yahooParse.js'
import type { NbaPlayer, Game, YahooWeek } from './types.js'
import { buildSeasonView, seasonTile } from './seasonView.js'
import { emptyBox, type NbaMatchup, type RosterDay, type TeamMeta } from './yahooSeason.js'
import type { SeasonLeague, Snapshot, World } from './inseason.js'
import { diffStatus } from './news.js'
import { allPlay } from './extras.js'

const players: NbaPlayer[] = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const schedule: Game[] = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8'))
const sdWeekly = Object.fromEntries(Object.entries(noise.raw).map(([k, v]: [string, any]) => [k, v.sdWeekly])) as any

const hoops: SeasonLeague & { myTeamId: string } = {
  id: 'nba-hoops-test', label: 'Hoops (test)', leagueKey: '478.l.1', scoring: 'categories', teams: 10,
  roster: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 3, BN: 5, IL: 3 }, adds: { perWeek: 10, season: 100 }, playoffWeeks: [19, 20, 21], myTeamId: '4',
}
const harker: SeasonLeague & { myTeamId: string } = {
  ...hoops, id: 'nba-harker-test', scoring: 'points', teams: 16, points: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 },
  roster: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 2, BN: 2, IL: 2 }, adds: { perWeek: 5, season: null }, playoffWeeks: [20, 21, 22], myTeamId: '3',
}

// Yahoo's weeks for 2026-27: Mondays from the opener's week.
const weeks: YahooWeek[] = Array.from({ length: 24 }, (_, i) => {
  const s = new Date(Date.UTC(2026, 9, 19 + 7 * i)), e = new Date(Date.UTC(2026, 9, 25 + 7 * i))
  return [i + 1, (i === 0 ? '2026-10-20' : s.toISOString().slice(0, 10)), e.toISOString().slice(0, 10)] as YahooWeek
})

const ypl = (p: NbaPlayer, slot: string | null, status: string | null = null): YPlayer => ({
  key: `478.p.${p.yahoo?.yahooId ?? p.id}`, yahooId: p.yahoo?.yahooId ?? `x${p.id}`, name: p.name, display: p.positions.join(','),
  primary: p.positions[0] ?? null, eligible: [...p.positions, 'Util'], team: p.team, status, injury: null, slot, points: null, byeWeek: null,
})

function drafted(league: SeasonLeague, rounds: number) {
  const pool = players.filter((p) => p.yahoo && p.projection && p.team).sort((a, b) => (a.yahoo!.adp ?? 999) - (b.yahoo!.adp ?? 999))
  const teams: NbaPlayer[][] = Array.from({ length: league.teams }, () => [])
  let i = 0
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 ? [...teams.keys()].reverse() : [...teams.keys()]
    for (const t of order) teams[t].push(pool[i++])
  }
  return teams
}

const meta = (id: string, mine: boolean, extra: Partial<TeamMeta> = {}): TeamMeta => ({
  key: `478.l.1.t.${id}`, id, name: mine ? 'Mine' : `Team ${id}`, manager: mine ? 'Me' : `M${id}`, mine,
  addsThisWeek: 2, moves: 20, waiverPriority: 3, faab: null, ...extra,
})

function snapshotFor(league: SeasonLeague & { myTeamId: string }, today: string): { snap: Snapshot; teams: NbaPlayer[][] } {
  const teams = drafted(league, league === hoops ? 13 : 9)
  const seatsOrder = ['PG', 'SG', 'SF', 'PF', 'C', 'Util', 'Util', 'Util', 'BN', 'BN', 'BN', 'BN', 'BN']
  const rosters = teams.map((ps, t) => ({
    team: meta(String(t + 1), String(t + 1) === league.myTeamId),
    players: ps.map((p, k) => ypl(p, seatsOrder[k] ?? 'BN')),
  }))
  const mineIdx = Number(league.myTeamId) - 1
  const wk = weeks.find(([, s, e]) => s <= today && today <= e)!
  const side = (t: number) => ({ ...meta(String(t + 1), t === mineIdx), box: { ...emptyBox(), fgm: 80, fga: 170, ftm: 40, fta: 50, tpm: 25, pts: 230, reb: 80, ast: 50, stl: 14, blk: 9, to: 26 }, points: 4, projected: null, games: null })
  const pairs: [number, number][] = []
  for (let t = 0; t < league.teams; t += 2) pairs.push([t, t + 1])
  const scoreboard: NbaMatchup[] = pairs.map(([a, b]) => ({ week: wk[0], start: wk[1], end: wk[2], status: 'midevent', playoffs: false, consolation: false, winnerTeamId: null, sides: [side(a), side(b)], leaders: {} }))
  // Today's lineup as set: my best players seated as drafted, whatever the schedule says.
  const mineToday: RosterDay = { team: rosters[mineIdx].team, date: today, players: rosters[mineIdx].players.map((y) => ({ ...y, box: null })) }
  return {
    teams,
    snap: {
      at: Date.parse(today + 'T16:00:00Z'), settings: { maxAdds: league.adds.season, maxWeeklyAdds: league.adds.perWeek, tradeEnd: '2027-02-04', playoffStartWeek: league.playoffWeeks[0], playoffTeams: 6, waiverType: 'R', waiverDays: 2, faab: false, scoringType: 'head' },
      weeks, rosters, mineToday, scoreboard, past: {}, standings: [], waivers: [], transactions: [],
    },
  }
}

const world = (today: string, never: string[] = []): World => ({
  players, logs: [], dayProj: new Map(), injuries: [], returns: new Map(), schedule, noise: { sdWeekly }, never: new Set(never),
  now: Date.parse(today + 'T16:00:00Z'), today,
})

test('a drafted 9-cat league reads as a full screen: lineup, week, adds, power, trades, playoffs', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const t0 = Date.now()
  const v = buildSeasonView(hoops, snap, world(today))
  const ms = Date.now() - t0
  assert.equal(v.phase, 'season')
  assert.equal(v.myTeam?.id, '4')
  assert.ok(v.lineup && v.lineup.rows.length === 13)
  assert.ok(v.week && v.week.odds && v.week.odds.races.length === 9)
  assert.ok(v.week!.odds!.expected > 0 && v.week!.odds!.expected < 9)
  assert.ok(v.budget!.season && v.budget!.season.max === 100)
  assert.equal(v.power.length, 10)
  assert.ok(v.playoffs && v.playoffs.mine.length > 0)
  assert.ok(ms < 8000, `built in ${ms}ms`)
  const tile = seasonTile(v, world(today).now)
  assert.ok(['act', 'soon', 'watch', 'quiet'].includes(tile.urgency))
  assert.equal(tile.link, '/nba/league/nba-hoops-test')
})

test('a starter with no game today is moved for a bench player who has one', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const w = world(today)
  const playing = new Set(schedule.filter((g) => g.date === today).flatMap((g) => [g.home, g.away]))
  const mine = snap.mineToday!.players
  const idleStarter = mine.find((y) => y.slot !== 'BN' && !playing.has(y.team!))
  const benchPlaying = mine.find((y) => y.slot === 'BN' && playing.has(y.team!))
  const v = buildSeasonView(hoops, snap, w)
  if (idleStarter && benchPlaying) {
    assert.ok(!v.lineup!.ok, 'the lineup as set wastes a start')
    assert.ok(v.lineup!.moves.length > 0)
    const m = v.lineup!.moves[0]
    assert.ok(m.by, 'a move says when it must be made by')
  } else {
    assert.ok(true, 'schedule gave no idle starter on this date')
  }
})

test('the never list stays out of pickups, trades, news and playoff targets', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const rostered = new Set(snap.rosters.flatMap((r) => r.players.map((y) => y.name)))
  // Never-list the best free agents, so they would otherwise be offered.
  const free = players.filter((p) => p.projection && p.team && !rostered.has(p.name)).sort((a, b) => (a.yahoo?.adp ?? 999) - (b.yahoo?.adp ?? 999)).slice(0, 15)
  const never = free.map((p) => p.id)
  const v = buildSeasonView(hoops, snap, world(today, never))
  const said = new Set([...v.pickups.map((p) => p.add), ...v.trades.flatMap((t) => t.get.map((g) => g.id)), ...v.news.map((n) => n.playerId), ...(v.playoffs?.targets.map((t) => t.id) ?? [])])
  for (const id of never) assert.ok(!said.has(id), `never-list player ${id} was offered`)
})

test('a points league builds the same screen with points odds and no punts', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(harker, today)
  const v = buildSeasonView(harker, snap, world(today))
  assert.ok(v.week?.points, 'points odds')
  assert.equal(v.week?.odds, null)
  assert.deepEqual(v.punts, [])
  assert.equal(v.power.length, 16)
  assert.ok(v.power.every((r) => r.score >= 0 && r.score <= 1))
  assert.equal(v.budget!.season, null)
  assert.equal(v.budget!.week!.max, 5)
})

test('before the draft the screen says so and builds nothing else', () => {
  const today = '2026-10-21'
  const { snap } = snapshotFor(hoops, today)
  const empty = { ...snap, rosters: snap.rosters.map((r) => ({ ...r, players: [] })), mineToday: null, scoreboard: [] }
  const v = buildSeasonView(hoops, empty, world(today))
  assert.equal(v.phase, 'before-draft')
  assert.equal(seasonTile(v, Date.now()).urgency, 'quiet')
})

test('status changes are read by diffing polls; a new player is not news', () => {
  const ev = diffStatus({ a: 'healthy', b: 'out' }, { a: 'out', b: 'healthy', c: 'out' }, 5)
  assert.deepEqual(ev.map((e) => [e.id, e.from, e.to]), [['a', 'healthy', 'out'], ['b', 'out', 'healthy']])
})

test('all-play counts every team every finished week and reads luck against the real record', () => {
  const s = (id: string, pts: number, mine = false) => ({ ...meta(id, mine), box: { ...emptyBox(), fgm: 10, fga: 20, ftm: 5, fta: 6, tpm: 3, pts, reb: pts / 3, ast: pts / 4, stl: 4, blk: 2, to: 5 }, points: pts, projected: null, games: null })
  const m = (a: any, b: any): NbaMatchup => ({ week: 1, start: null, end: null, status: 'postevent', playoffs: false, consolation: false, winnerTeamId: null, sides: [a, b], leaders: {} })
  // I am second best but drew the best team: a real loss, a strong all-play week.
  const past = { 1: [m(s('4', 90, true), s('1', 100)), m(s('2', 50), s('3', 40))] }
  const ap = allPlay(past, '4', 'points')!
  assert.deepEqual(ap.record, { w: 0, l: 1, t: 0 })
  assert.ok(Math.abs(ap.allPlay - 2 / 3) < 1e-9)
  assert.ok(ap.luck < 0, 'unlucky')
})

test('the tile acts only on a start lost before a tip within three hours; a better start is soon', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const v = buildSeasonView(hoops, snap, world(today))
  const tip = (h: number) => new Date(Date.parse(today + 'T16:00:00Z') + h * 3600000).toISOString()
  const at = Date.parse(today + 'T16:00:00Z')
  const lost = { ...v, lineup: { ...v.lineup!, ok: false, moves: [{ start: 'a', bench: 'b', why: 'B has no game today', by: tip(2) }] } }
  assert.equal(seasonTile(lost, at).urgency, 'act')
  const later = { ...v, lineup: { ...v.lineup!, ok: false, moves: [{ start: 'a', bench: 'b', why: 'B has no game today', by: tip(5) }] } }
  assert.equal(seasonTile(later, at).urgency, 'soon')
  const swap = { ...v, lineup: { ...v.lineup!, ok: false, moves: [{ start: 'a', bench: 'b', why: 'A is the better start today', by: tip(1) }] } }
  assert.equal(seasonTile(swap, at).urgency, 'soon')
})
