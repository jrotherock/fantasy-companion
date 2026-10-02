import { test } from 'node:test'
import assert from 'node:assert/strict'
import { categoryZ, effectiveGames, fantasyPoints, pointsValues, rankBuild, rosterProfile } from './value.js'
import type { NbaPlayer, PerGame } from './types.js'

const line: PerGame = { min: 30, pts: 15, reb: 5, ast: 3, stl: 1, blk: 0.5, tpm: 1.5, to: 1.5 }

function player(id: string, over: Partial<PerGame> = {}, opts: {
  fgPct?: number; fga?: number; ftPct?: number; fta?: number; gp?: number; gpSource?: 'fantasypros' | 'history' | 'default'; gpShare?: number | null
} = {}): NbaPlayer {
  return {
    id, name: id, team: 'BOS', positions: ['SF'], age: 25, yearsExp: 4, injury: null, yahoo: null, lines: {}, history: [],
    durability: { seasons: opts.gpShare == null ? 0 : 3, gpShare: opts.gpShare ?? null },
    projection: {
      perGame: { ...line, ...over },
      shooting: { fgPct: opts.fgPct ?? 0.47, fga: opts.fga ?? 12, ftPct: opts.ftPct ?? 0.78, fta: opts.fta ?? 3 },
      gp: opts.gp ?? 70, gpSource: opts.gpSource ?? 'fantasypros', sources: ['sleeper'],
    },
  }
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => player(`f${i}`, { pts: 8 + (i % 7), reb: 3 + (i % 4), min: 20 + (i % 10) }))

test('games blend the projection with the record, and a rookie keeps his projection', () => {
  assert.deepEqual(effectiveGames(player('a', {}, { gp: 70, gpShare: 0.5 })), { gp: (70 + 41) / 2, how: 'blend' })
  assert.deepEqual(effectiveGames(player('b', {}, { gp: 75, gpShare: null })), { gp: 75, how: 'projection' })
  assert.equal(effectiveGames(player('c', {}, { gp: 41, gpSource: 'history', gpShare: 0.5 })).how, 'history')
})

test('fantasy points follow the league\'s own weights', () => {
  // Harker: steals and blocks at three apiece, turnovers at minus one.
  const w = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 }
  assert.equal(fantasyPoints(player('a', { pts: 10, reb: 0, ast: 0, stl: 2, blk: 1, to: 1 }), w), 10 + 6 + 3 - 1)
})

test('points value is per-game margin over the replacement line times games', () => {
  const league = { teams: 2, roster: { C: 1, BN: 1, IL: 1 }, points: { pts: 1 } }
  // Four roster spots (IL does not count), so the fifth best sets the line.
  const ps = [30, 25, 20, 15, 10, 5].map((pts, i) => player(`p${i}`, { pts }, { gp: 60, gpShare: null }))
  const { rows, replacementFpg } = pointsValues(ps, league)
  assert.equal(replacementFpg, 10)
  assert.equal(rows[0].id, 'p0')
  assert.equal(rows[0].value, (30 - 10) * 60)
})

test('a durable player outranks a better one who will miss half the season in points', () => {
  // Two spots, so the third man sets the line.
  const league = { teams: 1, roster: { C: 2 }, points: { pts: 1 } }
  const ps = [player('fragile', { pts: 30 }, { gp: 40, gpShare: null }), player('durable', { pts: 26 }, { gp: 80, gpShare: null }), player('repl', { pts: 10 })]
  assert.equal(pointsValues(ps, league).rows[0].id, 'durable')
})

test('percentages are weighted by volume: efficient on many shots beats efficient on few', () => {
  const league = { teams: 2, roster: { C: 5 } }
  const ps = [
    ...filler(20),
    player('volume', {}, { fgPct: 0.55, fga: 20 }),
    player('sparing', {}, { fgPct: 0.65, fga: 3 }),
  ]
  const z = new Map(categoryZ(ps, league).map((r) => [r.id, r.z]))
  assert.ok(z.get('volume')!.fg > z.get('sparing')!.fg)
})

test('turnovers count against a player', () => {
  const league = { teams: 2, roster: { C: 5 } }
  const z = new Map(categoryZ([...filler(20), player('careless', { to: 5 }), player('careful', { to: 0.5 })], league).map((r) => [r.id, r.z]))
  assert.ok(z.get('careful')!.to > z.get('careless')!.to)
})

test('punting free throws lifts the big who cannot make them', () => {
  const league = { teams: 2, roster: { C: 5 } }
  const big = player('big', { reb: 12, blk: 2.5, tpm: 0 }, { fgPct: 0.62, fga: 10, ftPct: 0.5, fta: 6 })
  const guard = player('guard', { reb: 4, blk: 0.3, ast: 6, tpm: 2.5, pts: 18 }, { ftPct: 0.9, fta: 5 })
  const rows = categoryZ([...filler(20), big, guard], league)
  const rankOf = (punt: any[], id: string) => rankBuild(rows, league, punt).find((r) => r.id === id)!.rank
  assert.ok(rankOf(['ft'], 'big') < rankOf([], 'big'), 'the big climbs when FT% is punted')
  assert.ok(rankOf(['ft'], 'guard') > rankOf([], 'guard') || rankOf(['ft'], 'guard') === rankOf([], 'guard'))
})

test('a roster profile names the categories it is already losing', () => {
  const league = { teams: 2, roster: { C: 5 } }
  const bigs = ['b1', 'b2', 'b3'].map((id) => player(id, { reb: 11, blk: 2, ast: 1, tpm: 0 }, { ftPct: 0.55, fta: 5 }))
  const rows = categoryZ([...filler(20), ...bigs], league)
  const { weakest } = rosterProfile(rows, ['b1', 'b2', 'b3'])
  assert.ok(weakest.slice(0, 3).includes('ft'))
  assert.ok(weakest.slice(0, 3).includes('ast') || weakest.slice(0, 3).includes('tpm'))
})
