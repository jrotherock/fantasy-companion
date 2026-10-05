import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adpFor, adviseCategories, contribution, advisePoints, baseline, expectedBest, expectedCats, readBuild, winChances, zero, BUILD_FROM, DEFAULT_LATE_ADP } from './draft.js'
import { CATS, type Cat, type CatRow } from './value.js'

const flatNoise = Object.fromEntries(CATS.map((c) => [c, 2])) as Record<Cat, number>

function row(id: string, z: Partial<Record<Cat, number>>, adp: number, gp = 82): CatRow & { adp: number } {
  return {
    id, name: id, team: 'BOS', positions: ['SF'], yahooRank: null, adp,
    games: { gp, how: 'projection' },
    z: Object.fromEntries(CATS.map((c) => [c, z[c] ?? 0])) as Record<Cat, number>,
  }
}

test('ADP falls back to Yahoo\'s queue position, then to undrafted', () => {
  assert.equal(adpFor({ yahoo: { adp: 12.5, rank: 20 } }), 12.5)
  assert.equal(adpFor({ yahoo: { adp: null, rank: 140 } }), 140)
  assert.equal(adpFor({ yahoo: null }), DEFAULT_LATE_ADP)
})

test('expected best counts a player only if he survives and nobody better does', () => {
  // ADP far past the pick: always there. ADP far before it: never.
  assert.ok(Math.abs(expectedBest([{ value: 10, adp: 500 }], 20) - 10) < 1e-3)
  assert.ok(expectedBest([{ value: 10, adp: 1 }, { value: 4, adp: 500 }], 50) > 3.9)
  assert.ok(Math.abs(expectedBest([{ value: 10, adp: 1 }], 50, 2) - 2) < 1e-3, 'nobody left means the floor')
})

test('a player the room will leave alone is not worth a pick now', () => {
  // Same value, but one will be gone and the other will not. Take the one who will be gone.
  const spot = { teams: 10, rounds: 13, slot: 9, overall: 9 }
  const advice = advisePoints([
    { id: 'safe', name: 'safe', value: 100, adp: 60 },
    { id: 'hot', name: 'hot', value: 100, adp: 10 },
    { id: 'filler', name: 'filler', value: 50, adp: 300 },
  ], spot)
  assert.equal(advice[0].id, 'hot')
  assert.ok(advice.find((a) => a.id === 'safe')!.survives > 0.9)
})

test('the average team at each stage comes from the room drafting down ADP', () => {
  const rows = [row('a', { pts: 3 }, 1), row('b', { pts: 1 }, 2), row('c', { pts: 2 }, 3), row('d', { pts: 0 }, 4)]
  const base = baseline(rows, 2, 2, flatNoise)
  assert.equal(base.after[1].pts, (3 + 1) / 2)
  assert.equal(base.after[2].pts, (3 + 1 + 2 + 0) / 2)
  // Snake: team 1 takes a then d (3), team 2 b then c (3); no spread, so sigma is floored above zero.
  assert.ok(base.sigma.pts > 0)
})

test('even strength wins half the categories', () => {
  const rows = [row('a', { pts: 1, ast: 1 }, 1), row('b', { pts: -1, ast: 1 }, 2)]
  const base = baseline(rows, 2, 1, flatNoise)
  assert.equal(expectedCats(base.after[1], 1, base), 4.5)
  assert.equal(winChances(zero(), 0, base).reb, 0.5)
})

test('a lost category stops paying: the recommender adds where it can still win', () => {
  // A roster already hopeless in assists gains little from more assists and a lot
  // from a category that is close.
  const pool = Array.from({ length: 40 }, (_, i) => row(`p${i}`, { pts: (i % 5) - 2, ast: ((i * 3) % 5) - 2, reb: ((i * 7) % 5) - 2 }, i + 1))
  const base = baseline(pool, 4, 6, flatNoise)
  const mine = [row('m1', { ast: -12 }, 999), row('m2', { ast: -12 }, 999)]
  const spot = { teams: 4, rounds: 6, slot: 1, overall: 9 }
  const advice = adviseCategories([
    row('passer', { ast: 3 }, 500),
    row('rebounder', { reb: 3 }, 500),
  ], mine, spot, base)
  assert.equal(advice[0].id, 'rebounder')
})

test('no build is read, or steered toward, before the fourth pick', () => {
  const pool = Array.from({ length: 40 }, (_, i) => row(`p${i}`, { pts: (i % 5) - 2, ast: ((i * 3) % 5) - 2, reb: ((i * 7) % 5) - 2 }, i + 1))
  const base = baseline(pool, 4, 6, flatNoise)
  const lopsided = { ...zero(), ast: -24 }
  assert.deepEqual(readBuild(lopsided, BUILD_FROM - 1, base), { stage: 'open' })
  assert.equal(readBuild(lopsided, BUILD_FROM, base).stage, 'leaning')
  // Read neutrally, the advice does not depend on which way the first picks leaned.
  const spot = { teams: 4, rounds: 6, slot: 1, overall: 9 }
  const options = [row('passer', { ast: 3 }, 500), row('rebounder', { reb: 3 }, 500)]
  const after = (mine: ReturnType<typeof row>[]) =>
    adviseCategories(options, mine, spot, base, { neutralUntil: BUILD_FROM }).map((a) => [a.id, a.score.toFixed(9)])
  assert.deepEqual(after([row('m1', { ast: -12 }, 999), row('m2', { ast: -12 }, 999)]), after([row('m3', { reb: -12 }, 999), row('m4', { reb: -12 }, 999)]))
})

test('a player who barely plays is worth a waiver pickup, not nothing', () => {
  // Late in a draft every healthy player left is below the rostered average. Counting a
  // hurt player's missed games as zero made him look better than all of them.
  const waiver = Object.fromEntries(CATS.map((c) => [c, -1])) as Record<Cat, number>
  const healthy = { ...row('healthy', Object.fromEntries(CATS.map((c) => [c, -0.5])), 120), replacement: waiver }
  const hurt = { ...row('hurt', Object.fromEntries(CATS.map((c) => [c, 0.5])), 120, 1), replacement: waiver }
  for (const c of CATS) assert.ok(contribution(healthy)[c] > contribution(hurt)[c], c)
  assert.ok(Math.abs(contribution(hurt).pts - (-1 * 81 / 82 + 0.5 / 82)) < 1e-9)
})

test('back to back at the turn: everyone lasts one pick, and the pair leaves who will last longer', () => {
  // Picks 10 and 11 are mine, then 30. 'later' is the second-best player but the room
  // will leave him to pick 30; 'hot2' will not last. Take 'hot' and 'hot2' now.
  const spot = { teams: 10, rounds: 13, slot: 10, overall: 10 }
  const pool = [
    { id: 'hot', name: 'hot', value: 100, adp: 9 },
    { id: 'later', name: 'later', value: 95, adp: 200 },
    { id: 'hot2', name: 'hot2', value: 90, adp: 12 },
    { id: 'filler', name: 'filler', value: 20, adp: 300 },
  ]
  const advice = advisePoints(pool, spot)
  for (const a of advice) assert.equal(a.survives, 1)
  assert.equal(advice[0].id, 'hot')
  assert.equal(advice[0].then, 'hot2')
  // The second pick of the pair is an ordinary turn again: next at pick 30.
  assert.equal(advisePoints(pool, { ...spot, overall: 11 })[0].then, undefined)
  // Simulations can still draft the old way, for comparison.
  assert.ok(advisePoints(pool, { ...spot, naiveTurns: true })[0].survives < 1)
})

test('back to back in categories: the card names the partner that fits the pick best', () => {
  const pool = Array.from({ length: 40 }, (_, i) => row(`p${i}`, { pts: (i % 5) - 2, ast: ((i * 3) % 5) - 2, reb: ((i * 7) % 5) - 2 }, i + 1))
  const base = baseline(pool, 4, 6, flatNoise)
  const spot = { teams: 4, rounds: 6, slot: 4, overall: 4 }
  const advice = adviseCategories([row('passer', { ast: 3 }, 2), row('rebounder', { reb: 3 }, 3), row('scorer', { pts: 2 }, 50)], [], spot, base)
  for (const a of advice) {
    assert.equal(a.survives, 1)
    assert.ok(a.then && a.then !== a.id)
  }
})
