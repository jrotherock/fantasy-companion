import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKET_GAP, marketFlag, MIN_GAMES, rankPlayers, type PlayerRanks } from './ranks.js'
import { emptyBox } from './yahooSeason.js'
import type { NbaPlayer } from './types.js'
import type { GameLog } from './outlook.js'

const TODAY = '2026-11-17'
const mk = (id: string, pts: number, ast = 2, fg = 0.47): NbaPlayer => ({
  id, name: `P${id}`, team: 'BOS', positions: ['SF'], age: 25, yearsExp: 3, injury: null, yahoo: null, lines: {}, history: [],
  durability: { seasons: 3, gpShare: 0.9 },
  projection: {
    perGame: { min: 30, pts, reb: 5, ast, stl: 1, blk: 0.5, tpm: 1.5, to: 1.5 },
    shooting: { fga: 12, fgPct: fg, fta: 3, ftPct: 0.78 }, gp: 70, gpSource: 'fantasypros', sources: [],
  },
} as unknown as NbaPlayer)
const game = (id: string, date: string, pts: number, extra: Partial<ReturnType<typeof emptyBox>> = {}, min = 30): GameLog =>
  ({ id, date, team: 'BOS', min, box: { ...emptyBox(), fgm: 5, fga: 11, ftm: 2, fta: 3, tpm: 1, pts, reb: 5, ast: 2, stl: 1, blk: 0.5, to: 1.5, ...extra } })
const cats = { scoring: 'categories' as const, teams: 2, roster: { SF: 2, BN: 1, IL: 1 } }

test('ranks: each played window from its own games, yesterday back; too few games, no rank; the rest of the season from his line', () => {
  const ps = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => mk(id, 10 + i))
  const logs: GameLog[] = []
  for (const p of ps) for (const d of ['2026-10-25', '2026-11-05', '2026-11-12', '2026-11-14', '2026-11-16']) logs.push(game(p.id, d, 12))
  // a: hot this week, cold before it. b: great a month ago only. c: one big night only this week, and one today (still on).
  logs.push(game('a', '2026-11-15', 40), game('a', '2026-11-11', 40))
  for (const l of logs) if (l.id === 'a' && l.date < '2026-11-10') l.box.pts = 0
  logs.push(game('b', '2026-10-21', 60), game('b', '2026-10-22', 60))
  // c: one game this week (the others he sat), then a big one today, still on.
  logs.filter((l) => l.id === 'c' && l.date >= '2026-11-10' && l.date !== '2026-11-16').forEach((l) => (l.min = 0))
  logs.push(game('c', TODAY, 90))
  // e: the same points as d on far better shooting, every game.
  for (const l of logs) if (l.id === 'e') { l.box.fgm = 7; l.box.fga = 11 }
  const r = rankPlayers(ps, logs, TODAY, cats)
  assert.equal(r.get('a')!.d7.rank, 1, 'hottest of the week')
  assert.equal(r.get('a')!.d7.games, 5)
  assert.notEqual(r.get('a')!.d30.rank, 1, 'his month includes the cold games')
  assert.equal(r.get('b')!.d30.rank, 1)
  assert.ok(r.get('b')!.d7.rank! > 1)
  assert.equal(r.get('c')!.d7.rank, null, 'not enough games: a DNP is not a game, today does not count yet')
  assert.equal(r.get('c')!.d7.games, MIN_GAMES.d7 - 1)
  assert.ok(r.get('e')!.season.rank! < r.get('d')!.season.rank!, 'shooting from his own makes and attempts')
  // The rest of the season: by the line, the most points first.
  assert.equal(r.get('h')!.ros.rank, 1)
  assert.equal(r.get('a')!.ros.rank, 8)
  assert.equal(r.get('h')!.season.games, 5)
})

test('ranks: shooting is weighed by attempts, a punt makes its own order, a points league ranks by its weights', () => {
  // x: a high-volume poor shooter, y: same line on a few efficient shots. z: the assists man.
  const ps = [mk('x', 20, 2, 0.38), mk('y', 20, 2, 0.6), mk('z', 14, 9), ...['p', 'q', 'r', 's', 't'].map((id) => mk(id, 15))]
  ps[0].projection!.shooting.fga = 20
  const r = rankPlayers(ps, [], TODAY, { ...cats, punts: ['ast'] })
  assert.ok(r.get('y')!.ros.rank! < r.get('x')!.ros.rank!, 'the same points on bad volume is worth less')
  assert.ok(r.get('z')!.ros.build! > r.get('z')!.ros.rank!, 'his assists count for nothing under the punt')
  const pts = rankPlayers(ps, [], TODAY, { scoring: 'points', teams: 2, roster: cats.roster, points: { pts: 1, ast: 1.5 } })
  // x and y tie on points and assists; z: 14 + 13.5 = 27.5 beats 23.
  assert.equal(pts.get('z')!.ros.rank, 1)
  assert.equal(pts.get('z')!.ros.build, 1, 'no punts in points')
})

const pr = (d30: number | null, season: number | null, ros: number, build = ros): PlayerRanks => ({
  d7: { rank: null, build: null, games: 0 }, d30: { rank: d30, build: null, games: 5 }, season: { rank: season, build: null, games: 5 }, ros: { rank: ros, build, games: 0 },
})

test('sell high: mine, rated by the league well above his worth to me and like a roster player; buy low: theirs, the other way', () => {
  const line = 130
  // A hot month on a modest line: sell.
  assert.deepEqual(marketFlag(pr(40, 60, 40 + MARKET_GAP), true, line), { kind: 'sell', seen: 40, worth: 70, why: 'form' })
  assert.equal(marketFlag(pr(40, 60, 40 + MARKET_GAP - 1), true, line), null, 'not by enough')
  assert.equal(marketFlag(pr(140, 160, 200), true, line), null, 'the league would not want him either')
  // The same player on another roster is no buy; nor is mine a buy.
  assert.equal(marketFlag(pr(40, 60, 70), false, line), null)
  // A slumping star elsewhere: buy. Mine slumping: nothing to do.
  assert.deepEqual(marketFlag(pr(90, 80, 20), false, line), { kind: 'buy', seen: 90, worth: 20, why: 'form' })
  assert.equal(marketFlag(pr(90, 80, 20), true, line), null)
  assert.equal(marketFlag(pr(200, 200, 140), false, line), null, 'not worth a roster spot to me')
  // No month yet: the season is what the league sees; nothing at all, no flag.
  assert.equal(marketFlag(pr(null, 40, 80), true, line)!.seen, 40)
  assert.equal(marketFlag(pr(null, null, 80), true, line), null)
  // My punts: an assists guard others rate #30 on all nine and on form, worth #75 to my punt-assists build.
  assert.equal(marketFlag(pr(30, 30, 32, 75), true, line)!.why, 'punt')
  assert.equal(marketFlag(pr(30, 30, 50, 90), true, line)!.why, 'both')
  // A big with no assists, #95 to the league, #60 to me: a buy for my build.
  assert.equal(marketFlag(pr(95, 95, 92, 60), false, line)!.why, 'punt')
})
