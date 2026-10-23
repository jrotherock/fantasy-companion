import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { YPlayer } from '../server/yahooParse.js'
import type { NbaPlayer, Game, YahooWeek } from './types.js'
import { buildSeasonView, DO, LOOK, NOTIFY_PAIR_WINS, NOTIFY_WINS, pickupAlerts, seasonTile, verdictOf } from './seasonView.js'
import { emptyBox, type NbaMatchup, type RosterDay, type TeamMeta } from './yahooSeason.js'
import { Context, rosterIds, sideOutlook, soFarOf, type Fixture, type SeasonLeague, type Snapshot, type Whatif, type World } from './inseason.js'
import { addDays, PAIR_MARGIN, shortlistForWeek, STREAM_KEEP_MIN, STREAM_SEASON_COST, UPGRADE_WINS, WHATIFS, whatifFor, type PairMove } from './adds.js'
import { daysFrom, startingSeats } from './week.js'
import { categoryWeek, pointsWeek } from './matchup.js'
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

// ── Season pickups: every week left, against that week's opponent ──

/** A round robin (circle method) over the regular-season weeks before the playoffs: a different opponent most weeks. */
function fixturesFor(league: SeasonLeague): Fixture[] {
  const ids = Array.from({ length: league.teams }, (_, i) => String(i + 1))
  const out: Fixture[] = []
  for (const [n, s, e] of weeks.filter(([n]) => n < league.playoffWeeks[0])) {
    const r = (n - 1) % (ids.length - 1)
    const ring = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + r) % (ids.length - 1))])]
    const pairs: [string, string][] = []
    for (let i = 0; i < ids.length / 2; i++) pairs.push([ring[i], ring[ids.length - 1 - i]])
    out.push({ week: n, start: s, end: e, pairs })
  }
  return out
}

/** The same measure worked out by hand: each week left from tomorrow, against the opponent the schedule names. */
function winsByHand(league: SeasonLeague & { myTeamId: string }, snap: Snapshot, w: World, ids: { id: string; eligible: string[] }[], whatif: Map<string, Whatif> | null = null): number {
  const ctx = new Context(league, w)
  ctx.whatif = whatif
  for (const r of snap.rosters) for (const y of r.players) { const id = ctx.resolve(y); if (id) ctx.setStatus(id, y.status) }
  const seats = startingSeats(league.roster)
  const tomorrow = addDays(w.today, 1)
  let total = 0
  for (const f of snap.fixtures!.filter((x) => x.end >= tomorrow)) {
    const pair = f.pairs.find((p) => p.includes(league.myTeamId))!
    const opp = pair[0] === league.myTeamId ? pair[1] : pair[0]
    const days = daysFrom(f.start, f.end, f.start > tomorrow ? f.start : tomorrow)
    const theirs = sideOutlook(ctx, null, rosterIds(ctx, snap.rosters.find((r) => r.team.id === opp)!.players), seats, days).side
    const mine = sideOutlook(ctx, null, ids, seats, days).side
    if (league.scoring === 'categories') { const o = categoryWeek(mine, theirs); total += o.win + o.tie / 2 }
    else total += pointsWeek(mine, theirs, league.points ?? {}, { mine: null, theirs: null }).win
  }
  return total
}

for (const league of [hoops, harker]) {
  test(`${league.scoring}: a pickup's season gain is the matchups won over every week left, each against that week's opponent`, () => {
    const today = '2026-11-18'
    const { snap } = snapshotFor(league, today)
    snap.fixtures = fixturesFor(league)
    const w = world(today)
    const t0 = Date.now()
    const v = buildSeasonView(league, snap, w)
    const ms = Date.now() - t0
    assert.ok(ms < 8000, `built in ${ms}ms`)
    const left = snap.fixtures.filter((f) => f.end >= addDays(today, 1)).length
    assert.ok(left > 10, 'most of the regular season is left')
    const swaps = v.pickups.filter((p) => p.drop)
    assert.ok(swaps.length > 0, 'something to check')
    const ctx = new Context(league, w)
    const myIds = rosterIds(ctx, snap.rosters.find((r) => r.team.id === league.myTeamId)!.players)
    const base = winsByHand(league, snap, w, myIds)
    for (const p of swaps.slice(0, 3)) {
      assert.equal(p.seasonWeeks, left)
      assert.equal(p.scheduled, true)
      const after = winsByHand(league, snap, w, [...myIds.filter((x) => x.id !== p.drop), { id: p.add, eligible: p.positions }])
      assert.ok(Math.abs(p.seasonWins! - (after - base)) < 1e-6, `${p.name} for ${p.dropName}: ${p.seasonWins} vs ${after - base} by hand`)
    }
    // The drops weighed are the five the season would miss least, in matchups won without them.
    const missedBy = myIds.map((x) => ({ id: x.id, missed: base - winsByHand(league, snap, w, myIds.filter((y) => y.id !== x.id)) })).sort((a, b) => a.missed - b.missed)
    const fewest = new Set(missedBy.slice(0, 5).map((x) => x.id))
    for (const p of v.pickups) for (const d of [p.drop, ...p.alternatives.map((a) => a.drop)]) if (d) assert.ok(fewest.has(d), `${d} is not among the five least missed`)
    // It decides what a season move is: whatever clears the bar for an add, and nothing else, ranked by it.
    for (const p of swaps) assert.equal(p.kind !== 'stream', p.seasonWins! >= UPGRADE_WINS, `${p.name} for ${p.dropName}: ${p.kind}, ${p.seasonWins} wins`)
    // A stream drops someone for good: never one the season will miss by more than the cap.
    for (const p of swaps.filter((x) => x.kind === 'stream')) assert.ok(p.seasonWins! > -STREAM_SEASON_COST, `${p.name} for ${p.dropName}: ${p.seasonWins}`)
    const ups = v.pickups.filter((p) => p.kind === 'upgrade' && p.drop)
    assert.deepEqual(ups.map((p) => p.seasonWins), [...ups.map((p) => p.seasonWins)].sort((a, b) => b! - a!))
  })
}

test('a schedule read only part way: the weeks read against their opponents, the rest with this week’s standing in, not scheduled', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const all = fixturesFor(hoops)
  snap.fixtures = all.filter((f) => f.end < '2026-12-20')
  const v = buildSeasonView(hoops, snap, world(today))
  const p = v.pickups.find((x) => x.drop)!
  assert.equal(p.seasonWeeks, all.filter((f) => f.end >= '2026-11-19').length, 'every regular-season week is still counted')
  assert.equal(p.scheduled, false)
})

test('without the league schedule, this week’s opponent stands in for each regular-season week, and the pickup says so', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const v = buildSeasonView(hoops, snap, world(today))
  const p = v.pickups.find((x) => x.drop)!
  assert.equal(p.scheduled, false)
  assert.equal(p.seasonWeeks, weeks.filter(([n, , e]) => n < hoops.playoffWeeks[0] && e >= '2026-11-19').length)
})

test('past the next week a healthy player plays at his own season rate, not 95%', () => {
  const today = '2026-11-18'
  const w = world(today)
  const ctx = new Context(hoops, w)
  const fragile = players.find((p) => p.projection && p.team && !p.injury && p.projection.gp >= 50 && p.projection.gp <= 62)!
  const sturdy = players.find((p) => p.projection && p.team && !p.injury && p.projection.gp >= 80)!
  const games = (t: string) => schedule.filter((g) => g.home === t || g.away === t).length
  assert.equal(ctx.play(fragile.id, addDays(today, 3)), 0.95, 'this week: the near-term chance')
  assert.ok(Math.abs(ctx.play(fragile.id, addDays(today, 30)) - fragile.projection!.gp / games(fragile.team!)) < 1e-9, `${fragile.name}: ${fragile.projection!.gp} of ${games(fragile.team!)}`)
  assert.equal(ctx.play(sturdy.id, addDays(today, 30)), 0.95, 'never above the healthy chance')
  // Back from an injury on a date: his rate is over the games from then.
  const back = addDays(today, 20)
  const hurt = new Context(hoops, { ...w, returns: new Map([[fragile.id, back]]) })
  assert.equal(hurt.play(fragile.id, addDays(today, 10)), 0)
  const fromBack = schedule.filter((g) => (g.home === fragile.team || g.away === fragile.team) && g.date >= back).length
  assert.ok(Math.abs(hurt.play(fragile.id, addDays(today, 40)) - Math.min(0.95, fragile.projection!.gp / fromBack)) < 1e-9)
})

/** Each pair is both moves made together, worked out by hand, and worth a second move over either alone. */
function checkPairs(pairs: PairMove[], league: SeasonLeague & { myTeamId: string }, snap: Snapshot, w: World, myIds: { id: string; eligible: string[] }[], base: number, ctx: Context) {
  for (const pr of pairs) {
    assert.equal(pr.moves.length, 2)
    const [a, b] = pr.moves
    assert.ok(a.add !== b.add && a.drop !== b.drop)
    const roster = [...myIds.filter((x) => x.id !== a.drop && x.id !== b.drop), ...[a.add, b.add].map((id) => ({ id, eligible: [...ctx.byId.get(id)!.positions, 'Util'] }))]
    const together = winsByHand(league, snap, w, roster) - base
    assert.ok(Math.abs(pr.seasonWins - together) < 1e-6, `${a.name} + ${b.name}: ${pr.seasonWins} vs ${together} by hand`)
    assert.ok(pr.seasonWins >= Math.max(a.seasonWins, b.seasonWins) + PAIR_MARGIN - 1e-9, 'a second move’s worth over either alone')
  }
}

/** A league as Yahoo had it on 2026-10-19, from an analysis snapshot: rosters, the schedule, the season about to start. */
function realLeague(dir: string, base: SeasonLeague & { myTeamId: string }, me: string, playoffStart: number, today = '2026-10-19') {
  const d = JSON.parse(readFileSync(`scripts/nba-season-analysis/${dir}/sched.json`, 'utf8'))
  const byY = new Map(players.filter((p) => p.yahoo).map((p) => [p.yahoo!.yahooId, p]))
  const fixtures: Fixture[] = d.weeks.split('|').map((s: string) => { const [w, a, b, pairs] = s.split(':'); return { week: +w, start: a, end: b, pairs: pairs.split(',').map((x: string) => x.split('-')) } })
  const rosters = d.rosters.split('\n').map((line: string) => {
    const [tid, , list] = line.split('~')
    return { team: meta(tid, tid === me), players: list.split(',').map((y: string) => ({ y: y.replace('i', ''), il: y.endsWith('i') })).filter((x: any) => byY.has(x.y)).map((x: any) => ypl(byY.get(x.y)!, x.il ? 'IL' : 'BN')) }
  })
  const side = (t: TeamMeta) => ({ ...t, box: emptyBox(), points: 0, projected: null, games: null })
  const f1 = fixtures[0]
  const scoreboard: NbaMatchup[] = f1.pairs.map(([a, b]) => ({ week: 1, start: f1.start, end: f1.end, status: 'preevent', playoffs: false, consolation: false, winnerTeamId: null, sides: [side(rosters.find((r: any) => r.team.id === a)!.team), side(rosters.find((r: any) => r.team.id === b)!.team)], leaders: {} }))
  const snap: Snapshot = {
    at: Date.parse(today + 'T16:00:00Z'), settings: { maxAdds: null, maxWeeklyAdds: base.adds.perWeek, tradeEnd: null, playoffStartWeek: playoffStart, playoffTeams: 6, waiverType: 'R', waiverDays: 2, faab: false, scoringType: 'head' },
    weeks: fixtures.map((f) => [f.week, f.start, f.end] as YahooWeek), rosters, mineToday: null, scoreboard, past: {}, standings: [], waivers: [], transactions: [], fixtures,
  }
  const league = { ...base, myTeamId: me, playoffWeeks: [playoffStart, playoffStart + 1, playoffStart + 2] }
  const w = world(today)
  const ctx = new Context(league, w)
  const myIds = rosterIds(ctx, rosters.find((r: any) => r.team.id === me)!.players)
  return { league, snap, w, ctx, myIds }
}

const harkerLeague: SeasonLeague & { myTeamId: string } = {
  ...harker, id: 'nba-harker', teams: 12, roster: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 1, Util: 2, BN: 2, IL: 2 }, myTeamId: '3',
}

test('Harker on 2026-10-19: no stream drops a starter’s load (the plan streamed Kuminga for Jalen Green)', () => {
  const { league, snap, w: w0, ctx } = realLeague('2026-10-19-harker', harkerLeague, '3', 20)
  // Live, with Sleeper's lines, Kuminga was a twentieth of a win behind Green over the season; here he is made that
  // close (his line up a tenth), so only the starter's-load rule can keep Green.
  const up = 1.1
  const w = { ...w0, players: w0.players.map((p) => p.name !== 'Jonathan Kuminga' ? p : { ...p, projection: { ...p.projection!, perGame: Object.fromEntries(Object.entries(p.projection!.perGame).map(([k, x]) => [k, k === 'min' ? x : (x as number) * up])) as any } }) }
  const v = buildSeasonView(league, snap, w)
  for (const p of v.pickups.filter((x) => x.kind === 'stream')) {
    assert.ok((ctx.byId.get(p.drop!)?.projection?.perGame.min ?? 0) < STREAM_KEEP_MIN, `${p.name} streamed for ${p.dropName}`)
  }
  assert.ok(!v.pickups.some((p) => p.kind === 'stream' && p.dropName === 'Jalen Green'))
})

const publicLeague: SeasonLeague & { myTeamId: string } = {
  ...hoops, id: 'nba-public', roster: { PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 2, Util: 2, BN: 3, IL: 3 }, adds: { perWeek: 4, season: null }, myTeamId: '2',
}

for (const [label, dir, base, me, playoffStart] of [['Hoops', '2026-10-19-hoops', { ...hoops, id: 'nba-hoops' }, '4', 18], ['Public', '2026-10-19-public', publicLeague, '2', 20]] as const) {
  test(`${label} on 2026-10-19: drops are the five the season misses least, and no stream costs the season more than the cap`, () => {
    const { league, snap, w, ctx, myIds } = realLeague(dir, base, me, playoffStart)
    const v = buildSeasonView(league, snap, w)
    const all = winsByHand(league, snap, w, myIds)
    const fewest = new Set(myIds.map((x) => ({ id: x.id, missed: all - winsByHand(league, snap, w, myIds.filter((y) => y.id !== x.id)) })).sort((a, b) => a.missed - b.missed).slice(0, 5).map((x) => x.id))
    for (const p of v.pickups) for (const d of [p.drop, ...p.alternatives.map((a) => a.drop)]) if (d) assert.ok(fewest.has(d), `${ctx.byId.get(d)?.name ?? d} is not among the five least missed`)
    for (const p of v.pickups.filter((x) => x.kind === 'stream')) assert.ok(p.seasonWins! > -STREAM_SEASON_COST, `${p.name} for ${p.dropName}: ${p.seasonWins}`)
    if (label === 'Hoops') assert.ok(!v.pickups.some((p) => p.kind === 'stream' && p.dropName === 'Aaron Nesmith'), 'the season pickup is not streamed away')
    checkPairs(v.pairs, league, snap, w, myIds, all, ctx)
    if (label === 'Public') assert.ok(v.pairs.length > 0, 'the public league’s best is two moves')
    // Public punts FG% and REB: by per-game value Siakam and Mikal Bridges were among the five weakest and VanVleet and
    // Herro were not; in matchups won it is the other way round, and the moves for VanVleet and Herro are the ones offered.
    if (label === 'Public') assert.ok(v.pickups.some((p) => [p.dropName, ...p.alternatives.map((a) => a.dropName)].some((n) => n === 'Fred VanVleet' || n === 'Tyler Herro')), 'VanVleet or Herro weighed as a drop')
  })
}

test("an absent player's minutes go to his healthy teammates, his position first, until he is back", () => {
  const today = '2026-10-19'
  const aj = players.find((p) => p.name === 'AJ Dybantsa')!
  const ky = players.find((p) => p.name === 'Kyshawn George')!
  const w = { ...world(today), returns: new Map([[aj.id, '2026-11-01']]) }
  const ctx = new Context(hoops, w)
  const out = '2026-10-25', back = '2026-11-12'
  const games = schedule.filter((g) => g.home === 'WAS' || g.away === 'WAS').length
  const freed = aj.projection!.perGame.min * Math.min(1, aj.projection!.gp / games)
  const mates = players.filter((p) => p.team === 'WAS' && p.id !== aj.id && p.projection)
  const given = mates.reduce((s, p) => s + ctx.minutesFrom(p.id, out), 0)
  // All of them, but for what would take someone past 36.
  assert.ok(given <= freed + 1e-9 && given > 0.95 * freed, `${given.toFixed(2)} of ${freed.toFixed(2)} minutes given out`)
  for (const p of mates) assert.ok(p.projection!.perGame.min + ctx.minutesFrom(p.id, out) <= 36 + 1e-9 || ctx.minutesFrom(p.id, out) === 0, `${p.name} past 36`)
  assert.equal(ctx.minutesFrom(aj.id, out), 0, 'not to himself')
  // Per minute he already plays, a teammate at AJ's position gains three times what one at none of them does.
  const group = (p: NbaPlayer) => p.positions.map((x) => (x === 'PG' || x === 'SG' ? 'G' : x === 'SF' || x === 'PF' ? 'F' : 'C'))
  const shares = (p: NbaPlayer) => group(p).some((g) => group(aj).includes(g))
  const rate = (p: NbaPlayer) => ctx.minutesFrom(p.id, out) / p.projection!.perGame.min
  const uncapped = mates.filter((p) => p.projection!.perGame.min >= 12 && p.projection!.perGame.min + ctx.minutesFrom(p.id, out) < 36 - 1e-6)
  const same = uncapped.find(shares), other = uncapped.find((p) => !shares(p))
  assert.ok(same && other, 'one of each to compare')
  assert.ok(Math.abs(rate(same!) / rate(other!) - 3) < 1e-6, `${same!.name} ${rate(same!).toFixed(3)} vs ${other!.name} ${rate(other!).toFixed(3)}`)
  assert.ok(ctx.minutesFrom(ky.id, out) > 1, `Kyshawn George picks up ${ctx.minutesFrom(ky.id, out).toFixed(1)}`)
  for (const p of mates.filter((x) => x.projection!.perGame.min < 12)) assert.equal(ctx.minutesFrom(p.id, out), 0, `${p.name} is outside the rotation`)
  const f = (ky.projection!.perGame.min + ctx.minutesFrom(ky.id, out)) / ky.projection!.perGame.min
  assert.ok(Math.abs(ctx.outlook(ky.id, out)!.box.pts - ky.projection!.perGame.pts * f) < 1e-9, 'his line follows the minutes')
  assert.equal(ctx.minutesFrom(ky.id, back), 0, 'nothing once AJ is back')
  // A healthy Washington moves nobody.
  assert.equal(new Context(hoops, world(today)).minutesFrom(ky.id, out), 0)
  // Where Sleeper has a line for the date, it counts half, his own line (with the minutes) the other half.
  const line = { box: { ...emptyBox(), pts: 9 }, min: 25 }
  const own = ctx.outlook(ky.id, out)!.box.pts
  const withLine = new Context(hoops, { ...w, dayProj: new Map([[`${ky.id}|${out}`, line]]) })
  assert.ok(Math.abs(withLine.outlook(ky.id, out)!.box.pts - (0.5 * 9 + 0.5 * own)) < 1e-9)
  assert.equal(withLine.outlook(ky.id, back)!.box.pts, ky.projection!.perGame.pts, 'a date Sleeper has no line for is his own')
  // Sleeper alone, the way it was.
  assert.equal(new Context(hoops, { ...w, sleeperWeight: 1, dayProj: new Map([[`${ky.id}|${out}`, line]]) }).outlook(ky.id, out)!.box.pts, 9)
})

test('pickup alerts: the best season move, the best pair and the best stream, each once, named by its players', () => {
  const { league, snap, w } = realLeague('2026-10-19-public', publicLeague, '2', 20)
  const v = buildSeasonView(league, snap, w)
  const a = pickupAlerts(v, '/nba/league/nba-public')
  const season = a.find((x) => x.rule === 'nba-pickup')!
  const top = v.pickups.filter((p) => p.kind !== 'stream' && p.drop).sort((x, y) => y.seasonWins! - x.seasonWins!)[0]
  assert.ok(top.seasonWins! >= NOTIFY_WINS)
  assert.equal(season.id, `nba-pickup:nba-public:${top.add}:${top.drop}`, 'the best one, named by who is added and dropped')
  assert.ok(season.consequence < 70, 'under a lineup move')
  const pair = a.find((x) => x.rule === 'nba-pair')!
  assert.ok(pair && v.pairs[0].seasonWins >= NOTIFY_PAIR_WINS)
  assert.ok(pair.headline.includes(v.pairs[0].seasonWins.toFixed(2)))
  // The same screen again says the same thing, so it is sent once.
  assert.deepEqual(pickupAlerts(buildSeasonView(league, snap, w), '/nba/league/nba-public').map((x) => x.id), a.map((x) => x.id))
  // Nothing worth a quarter of a win: nothing sent.
  const quiet = { ...v, pickups: v.pickups.map((p) => ({ ...p, seasonWins: 0.2 })), pairs: [] }
  assert.deepEqual(pickupAlerts(quiet, '/x').filter((x) => x.rule !== 'nba-stream'), [])
  // A stream that moves the week by ten points, with adds to spend; none with no adds left.
  const s = { ...v, week: { ...v.week!, week: 1, end: '2026-10-25' }, budget: { ...v.budget!, forStreams: 2 }, pickups: [{ ...v.pickups[0], kind: 'stream' as const, winBefore: 0.45, winAfter: 0.58, startsThisWeek: 3, seasonWins: -0.05 }], pairs: [] }
  const st = pickupAlerts(s, '/x').find((x) => x.rule === 'nba-stream')!
  assert.equal(st.id, `nba-stream:nba-public:1:${v.pickups[0].add}`)
  assert.ok(st.deadline! > Date.parse('2026-10-25T12:00:00Z'), 'it lasts the week')
  assert.equal(pickupAlerts({ ...s, budget: { ...s.budget, forStreams: 0 } }, '/x').filter((x) => x.rule === 'nba-stream').length, 0)
})

test('the week so far: lines in an active spot count, bench lines do not, each with his projection; today is the freshest read', () => {
  const today = '2026-11-18'
  const ctx = new Context(hoops, world(today))
  const [a, b] = players.filter((p) => p.yahoo && p.projection && p.team).slice(0, 2)
  const line = (pts: number) => ({ ...emptyBox(), fgm: 4, fga: 9, ftm: 2, fta: 2, tpm: 1, pts, reb: 5, ast: 3, stl: 1, blk: 0, to: 2 })
  const day = (date: string, rows: [NbaPlayer, string, number | null][]): RosterDay => ({ team: meta('4', true), date, players: rows.map(([p, slot, pts]) => ({ ...ypl(p, slot), box: pts == null ? null : line(pts) })) })
  const days = {
    '2026-11-16': day('2026-11-16', [[a, 'PG', 20], [b, 'BN', 15]]),
    '2026-11-17': day('2026-11-17', [[a, 'PG', null], [b, 'Util', 12]]),
    '2026-11-18': day('2026-11-18', [[a, 'PG', 3], [b, 'Util', null]]),
    '2026-11-19': day('2026-11-19', [[a, 'PG', 99], [b, 'Util', 99]]),
  }
  const fresher = day('2026-11-18', [[a, 'PG', 25], [b, 'Util', null]])
  const rows = soFarOf(ctx, days, fresher, today)
  const ra = rows.find((r) => r.id === a.id)!, rb = rows.find((r) => r.id === b.id)!
  assert.deepEqual([ra.played, ra.started, ra.box.pts], [2, 2, 45], 'two games counted; today is the fresher read; tomorrow is not yet')
  assert.deepEqual([rb.played, rb.started, rb.box.pts, rb.bench.pts], [2, 1, 12, 15], 'his bench game did not count')
  const proj = (p: NbaPlayer, d: string) => ctx.outlook(p.id, d)!.box.pts
  assert.ok(Math.abs(ra.proj.pts - (proj(a, '2026-11-16') + proj(a, '2026-11-18'))) < 1e-9, 'his projection for the games that counted')
  assert.ok(Math.abs(rb.proj.pts - proj(b, '2026-11-17')) < 1e-9, 'not for the one on the bench')
})

test('points: the players this week add up to the projected week (their starts as the projection seats them)', () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(harker, today)
  const v = buildSeasonView(harker, snap, world(today))
  const w = harker.points!
  const fp = (b: any) => Object.entries(w).reduce((s, [k, x]) => s + (x ?? 0) * (b[k] ?? 0), 0)
  const rest = v.week!.players.reduce((s, p) => s + fp(p.box), 0)
  assert.ok(Math.abs(v.week!.points!.mineNow + rest - v.week!.points!.mine) < 0.5, `${v.week!.points!.mineNow} + ${rest.toFixed(1)} vs ${v.week!.points!.mine.toFixed(1)}`)
})

test("the live scoreboard says when a game is on and over, not the tip time; each row gets its score and clock", () => {
  const today = '2026-11-18'
  const { snap } = snapshotFor(hoops, today)
  const rows = snap.mineToday!.players
  const mine = rows.map((y) => players.find((p) => p.yahoo?.yahooId === y.yahooId)!).filter(Boolean)
  const games = schedule.filter((g) => g.date === today)
  const withGame = mine.filter((p) => games.some((g) => g.home === p.team || g.away === p.team))
  assert.ok(withGame.length >= 2, 'two of mine play')
  const [a, b] = withGame
  const ga = games.find((g) => g.home === a.team || g.away === a.team)!, gb = games.find((g) => g.home === b.team || g.away === b.team)!
  // Before any tip by the clock (16:00Z), but the scoreboard has one game over and one in the 3rd.
  const w = { ...world(today), scores: [
    { home: ga.home, away: ga.away, homeScore: 101, awayScore: 99, state: 'post' as const, period: 4, clock: '0.0', detail: 'Final' },
    ...(gb === ga ? [] : [{ home: gb.home, away: gb.away, homeScore: 70, awayScore: 72, state: 'in' as const, period: 3, clock: '6:00', detail: '6:00 - 3rd' }]),
  ] }
  const v = buildSeasonView(hoops, snap, w)
  const ra = v.lineup!.rows.find((r) => r.id === a.id)!
  assert.deepEqual([ra.game!.started, ra.game!.final, ra.game!.status], [true, true, 'Final'])
  assert.deepEqual(ra.game!.score, a.team === ga.home ? { us: 101, them: 99 } : { us: 99, them: 101 })
  if (gb !== ga) {
    const rb = v.lineup!.rows.find((r) => r.id === b.id)!
    assert.deepEqual([rb.game!.started, rb.game!.final, rb.game!.status, rb.game!.played], [true, false, 'Q3 6:00', 0.625])
  }
  // Without the scoreboard, the tip time decides: nothing has tipped at 16:00Z.
  const plain = buildSeasonView(hoops, snap, world(today)).lineup!.rows.find((r) => r.id === a.id)!
  assert.deepEqual([plain.game!.started, plain.game!.score], [false, null])
})

test("tomorrow's lineup as set: a starter whose team is off while a bench player plays is a start lost, said a day ahead", () => {
  const today = '2026-11-18', tomorrow = '2026-11-19'
  const { snap } = snapshotFor(hoops, today)
  const plays = new Set(schedule.filter((g) => g.date === tomorrow).flatMap((g) => [g.home, g.away]))
  const day = snap.mineToday!.players
  const idleStarter = day.find((y) => y.slot !== 'BN' && !plays.has(y.team!))
  const benchPlaying = day.find((y) => y.slot === 'BN' && plays.has(y.team!))
  assert.ok(idleStarter && benchPlaying, 'the fixture has both tomorrow')
  snap.mineTomorrow = { ...snap.mineToday!, date: tomorrow }
  const v = buildSeasonView(hoops, snap, world(today))
  assert.equal(v.tomorrow!.date, tomorrow)
  const byId = (y: { yahooId: string }) => players.find((p) => p.yahoo?.yahooId === y.yahooId)!.id
  for (const m of v.tomorrow!.moves) assert.ok(plays.has(players.find((p) => p.id === m.start)!.team!), 'only a player who plays tomorrow is started')
  assert.ok(v.tomorrow!.lostStarts > 0)
  const idle = new Set(day.filter((y) => y.slot !== 'BN' && y.slot !== 'IL' && !plays.has(y.team!)).map(byId))
  assert.ok(v.tomorrow!.moves.some((m) => m.bench && idle.has(m.bench) && /no game tomorrow/.test(m.why)), 'a starter who is off tomorrow comes out, and says why')
  // Nothing to do tonight: the home tile says to set tomorrow's.
  const quiet = { ...v, lineup: { ...v.lineup!, moves: [] } }
  assert.equal(seasonTile(quiet, world(today).now).action, "Set tomorrow's lineup")
  // Read for another day (yesterday's read of "tomorrow"): not used.
  snap.mineTomorrow = { ...snap.mineToday!, date: today }
  assert.equal(buildSeasonView(hoops, snap, world(today)).tomorrow, null)
})

test("a move's confidence: the players in it re-scored under ten what-ifs, the rest as projected, worked out by hand", () => {
  const { league, snap, w, myIds } = realLeague('2026-10-19-public', publicLeague, '2', 20)
  const v = buildSeasonView(league, snap, w)
  const p = v.pickups.find((x) => x.kind !== 'stream' && x.drop && x.confidence)!
  assert.ok(p, 'a checked season move')
  const after = [...myIds.filter((x) => x.id !== p.drop), { id: p.add, eligible: [...players.find((x) => x.id === p.add)!.positions, 'Util'] }]
  const gains = Array.from({ length: WHATIFS }, (_, i) => {
    const wi = new Map([[p.add, whatifFor(p.add, i)], [p.drop!, whatifFor(p.drop!, i)]])
    return winsByHand(league, snap, w, after, wi) - winsByHand(league, snap, w, myIds, wi)
  })
  const sorted = [...gains].sort((a, b) => a - b)
  assert.equal(p.confidence!.holds, gains.filter((g) => g > 0).length)
  assert.ok(Math.abs(p.confidence!.low - sorted[1]) < 1e-6 && Math.abs(p.confidence!.high - sorted[WHATIFS - 2]) < 1e-6, `${p.confidence!.low} ${p.confidence!.high} vs ${sorted[1]} ${sorted[WHATIFS - 2]}`)
  assert.ok(p.confidence!.high > p.confidence!.low, 'the what-ifs move it')
  // The same move gets the same what-ifs every time.
  assert.deepEqual(buildSeasonView(league, snap, w).pickups.find((x) => x.add === p.add && x.drop === p.drop)!.confidence, p.confidence)
})

test('the Adds verdict: do this, worth a look, or nothing, by worth and by how sure; the home tile says the same', () => {
  const { league, snap, w } = realLeague('2026-10-19-public', publicLeague, '2', 20)
  const v = buildSeasonView(league, snap, w)
  assert.ok(v.verdict && v.verdict.level !== 'none', 'the public league has a move')
  const t = seasonTile({ ...v, lineup: v.lineup ? { ...v.lineup, moves: [] } : null, tomorrow: null }, w.now)
  assert.ok(t.why.startsWith(v.verdict!.headline), `${t.why} / ${v.verdict!.headline}`)
  // Made by hand: one season move, then its worth and its confidence moved across the bars.
  const one = v.pickups.find((x) => x.kind !== 'stream' && x.drop)!
  const at = (season: number, holds: number) => verdictOf({ ...v, pairs: [], addPlan: null, pickups: [{ ...one, seasonWins: season, confidence: { holds, of: 10, low: 0, high: season } }] })!
  assert.equal(at(DO.season, DO.holds).level, 'do')
  assert.equal(at(DO.season, DO.holds - 1).level, 'look', 'worth it but not sure enough: a look')
  assert.equal(at(LOOK.season, LOOK.holds).level, 'look')
  assert.equal(at(LOOK.season - 0.01, 10).level, 'none', 'sure but too small: nothing')
  assert.equal(at(DO.season, LOOK.holds - 1).level, 'none', 'big but unsure: nothing')
  assert.match(at(0.05, 4).reasons[0], new RegExp(`${one.name} for ${one.dropName}`), 'the nothing names the best on offer')
})

test("streams are shortlisted by games in my empty spots above a floor: a third game counts for more, never less", () => {
  const worth: Record<string, number> = { three: -4, two: -4, better: -1, none: 2 }
  const games: Record<string, number> = { three: 3, two: 2, better: 2, none: 0 }
  const order = shortlistForWeek(Object.keys(worth), (id) => worth[id], (id) => games[id], -6, 10)
  assert.ok(order.indexOf('three') < order.indexOf('two'), 'the same man with a third game ranks higher (value times games ranked him lower)')
  assert.equal(order.indexOf('better'), 0, '(−1 − −6) × 2 = 10 beats (−4 − −6) × 3 = 6')
  assert.ok(!order.includes('none'), 'no games in an empty spot: not a stream')
})

test("Hoops on 2026-10-21: Philadelphia's Thursday and Sunday, Hoops' emptiest nights, put Simons on the stream list", () => {
  const { league, snap, w } = realLeague('2026-10-21-hoops', { ...hoops, id: 'nba-hoops' }, '4', 18, '2026-10-21')
  const v = buildSeasonView(league, snap, w)
  const simons = players.find((p) => p.name === 'Anfernee Simons')!
  const s = v.pickups.find((p) => p.add === simons.id)
  assert.ok(s, `Simons offered; offered: ${v.pickups.map((p) => p.name).join(', ')}`)
  assert.deepEqual(s!.playDays.filter((d) => d.open).map((d) => d.date), ['2026-10-22', '2026-10-25'], 'his Thursday and Sunday go into empty spots')
})

test('when the verdict is a pair, the week plan leads with both moves at the verdict\'s time and repeats neither', () => {
  const { league, snap, w } = realLeague('2026-10-19-public', publicLeague, '2', 20)
  const v = buildSeasonView(league, snap, w)
  assert.equal(v.verdict!.kind, 'pair', 'the public league of 2026-10-19 calls for two moves')
  const pair = v.pairs[0]
  const steps = v.addPlan!.steps
  assert.deepEqual(steps.slice(0, 2).map((st) => [st.add, st.drop, st.when]), pair.moves.map((m) => [m.name, m.dropName, v.verdict!.when]))
  const names = new Set(pair.moves.flatMap((m) => [m.name, m.dropName]))
  assert.ok(steps.slice(2).every((st) => !names.has(st.add) && !(st.drop && names.has(st.drop))), 'nothing else adds or drops the same players')
})
