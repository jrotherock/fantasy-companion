import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseMocks, MIN_MOCKS, type MockRecord, type MockPick } from './tendencies.js'

const pick = (round: number, took: string, advised: string, cost: number, extra: Partial<MockPick> = {}): MockPick => ({
  overall: round * 10, round, took, tookPositions: ['PG'], advised, advisedPositions: ['C'], cost, waitedWrong: false, stage: 'leaning', ...extra,
})
const mock = (id: string, result: number, picks: MockPick[], extra: Partial<MockRecord> = {}): MockRecord => ({
  id, when: Date.now(), seat: 9, result, punting: [], win: null, locks: [], lockedFromRound: null, picks, ...extra,
})

test('below the minimum it says so instead of finding patterns', () => {
  const r = analyseMocks([mock('a', 5, [pick(1, 'X', 'X', 0)])], 'categories')
  assert.equal(r.mocks, 1)
  assert.equal(r.playbook.length, 0)
  assert.match(r.headline, new RegExp(`at least ${MIN_MOCKS}`))
})

test('departures are costed and named, and a lock names the build', () => {
  const follow = Array.from({ length: 5 }, (_, i) => pick(i + 1, `A${i}`, `A${i}`, 0))
  const stray = [pick(1, 'Guard', 'Big', 0.12), pick(2, 'Guard2', 'Big2', 0.1), pick(3, 'Guard3', 'Big3', 0.08), pick(4, 'B', 'B', 0)]
  const r = analyseMocks([
    mock('a', 5.8, follow, { locks: ['ft'], punting: ['ft'] }),
    mock('b', 5.2, stray, { punting: ['ast'] }),
  ], 'categories')
  const adherence = r.tendencies.find((t) => t.id === 'adherence')!
  assert.match(adherence.headline, /67%/)
  assert.match(adherence.detail, /Guard over Big/)
  assert.ok(r.playbook.some((p) => p.id === 'follow'))
  assert.deepEqual(r.byBuild.map((b) => b.build), ['punt FT% (locked)', 'punt AST'])
  assert.ok(r.tendencies.some((t) => t.id === 'drift'), 'three guards over bigs is a habit worth naming')
})

test('a category lost without a lock in most mocks becomes a playbook item; a locked one does not', () => {
  const ps = [pick(1, 'A', 'A', 0)]
  const r = analyseMocks([
    mock('a', 5, ps, { punting: ['stl'] }), mock('b', 5, ps, { punting: ['stl'] }), mock('c', 5, ps, { punting: ['blk'], locks: ['blk'] }),
  ], 'categories')
  assert.ok(r.playbook.some((p) => p.id === 'drifted' && /STL/.test(p.action)))
  assert.ok(!r.playbook.some((p) => /BLK/.test(p.action)))
})

test('points leagues are measured in value and have no builds', () => {
  const r = analyseMocks([mock('a', 6000, [pick(1, 'A', 'A', 0)]), mock('b', 5800, [pick(1, 'B', 'C', 120)])], 'points')
  assert.equal(r.unit, 'value')
  assert.deepEqual(r.byBuild.map((b) => b.build), ['all'])
  assert.match(r.headline, /season value/)
})
