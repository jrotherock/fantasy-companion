import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFits, type Squad } from './trades.js'

const REQ = { QB: 1, RB: 2, WR: 2, TE: 1 }
const sq = (teamId: string, manager: string, spec: [string, string, number][]): Squad => ({
  teamId, manager,
  players: spec.map(([name, pos, projected]) => ({ id: name, name, pos, projected })),
})

const me = sq('me', 'me', [
  ['QB1', 'QB', 18], ['RB1', 'RB', 15], ['RB2', 'RB', 13], ['RB3', 'RB', 12], ['RB4', 'RB', 11],
  ['WR1', 'WR', 12], ['TE1', 'TE', 9],
])

test('finds the manager who is the mirror image of you', () => {
  const mirror = sq('t2', 'Arthur', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 14],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12], ['TE1', 'TE', 8],
  ])
  const fits = findFits(me, [mirror], REQ)
  assert.equal(fits.length, 1)
  assert.equal(fits[0].manager, 'Arthur')
  assert.equal(fits[0].theyCanSpare.pos, 'WR')
  assert.equal(fits[0].youCanSpare.pos, 'RB')
})

test('a manager deep everywhere is not a trade partner', () => {
  const stacked = sq('t3', 'Rich', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 15], ['RB2', 'RB', 14], ['RB3', 'RB', 13],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 13], ['TE1', 'TE', 9],
  ])
  assert.equal(findFits(me, [stacked], REQ).length, 0)
})

test('it only ever offers players past the starters', () => {
  const mirror = sq('t2', 'Arthur', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 14],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12], ['TE1', 'TE', 8],
  ])
  const f = findFits(me, [mirror], REQ)[0]
  assert.deepEqual(f.youCanSpare.players.map((p) => p.name), ['RB3', 'RB4'])
  assert.deepEqual(f.theyCanSpare.players.map((p) => p.name), ['WR3'])
})

test('needing and sparing the same position is not a trade', () => {
  const odd = sq('t4', 'Sam', [['RB1', 'RB', 14], ['RB2', 'RB', 13], ['RB3', 'RB', 12]])
  assert.ok(findFits(me, [odd], REQ).every((f) => f.theyCanSpare.pos !== f.youCanSpare.pos))
})

test('a weak starter counts as a need even with bodies present', () => {
  const thin = sq('me2', 'me', [
    ['QB1', 'QB', 18], ['RB1', 'RB', 15], ['RB2', 'RB', 13], ['RB3', 'RB', 12],
    ['WR1', 'WR', 3], ['WR2', 'WR', 2], ['TE1', 'TE', 9],
  ])
  const mirror = sq('t2', 'Arthur', [
    ['RB1', 'RB', 14], ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12],
  ])
  const fits = findFits(thin, [mirror], REQ, ['WR'])
  assert.equal(fits.length, 1, 'two bad receivers still fill two slots, so only weakAt finds this')
  assert.equal(fits[0].theyCanSpare.pos, 'WR')
})

test('a man the projection is silent about is never offered as spare', () => {
  /*
   * Unprojected sorts last, as though he scored nothing, so a star the week's
   * projection had not reached was put on offer as spare cover.
   */
  const withStar = {
    ...me,
    players: me.players.map((p) => (p.name === 'RB3' ? { ...p, name: 'Star', projected: null } : p)),
  }
  const mirror = sq('t2', 'Arthur', [
    ['QB1', 'QB', 17], ['RB1', 'RB', 14],
    ['WR1', 'WR', 16], ['WR2', 'WR', 14], ['WR3', 'WR', 12], ['TE1', 'TE', 8],
  ])
  const fits = findFits(withStar, [mirror], REQ)
  assert.ok(fits.length === 1)
  assert.ok(!fits[0].youCanSpare.players.some((p) => p.name === 'Star'))
  assert.deepEqual(fits[0].youCanSpare.players.map((p) => p.name), ['RB4'])
})

/*
 * The finder is fed by `levelOver`, so the bye belongs in its own test here:
 * what the finder must never do is read a fixture list as a weakness.
 */
test('a bye week is not a weak spot', async () => {
  const { levelOver } = await import('./projections.js')
  const { weakSpots } = await import('./trades.js')
  const table = (week: number, pts: Record<string, number>) => ({
    week, season: '2026', at: 0,
    pts: new Map(Object.entries(pts)),
    stats: new Map<string, Record<string, number>>(),
  })
  /*
   * Week six, and my two best backs are Vikings. Every manager here has the
   * same quality of running back; only the calendar differs.
   */
  // The Vikings print nought on their bye rather than vanishing from the
  // table — the case where leaving the week out is what does the work.
  const w6 = { jones: 0, gibbs: 0, mason: 9.1, taylor: 14.2, hall: 12.0, spears: 8.8 }
  const w7 = { jones: 14.0, gibbs: 15.5, mason: 9.0, taylor: 14.0, hall: 12.2, spears: 8.6 }
  const w8 = { jones: 13.6, gibbs: 16.1, mason: 9.4, taylor: 13.4, hall: 11.6, spears: 9.2 }
  const tables = [table(6, w6), table(7, w7), table(8, w8)]
  const BYE: Record<string, number | null> = { jones: 6, gibbs: 6 }
  const squad = (teamId: string, ids: string[]): Squad => ({
    teamId, manager: teamId,
    players: ids.map((id) => ({
      id, name: id, pos: 'RB',
      projected: levelOver(tables, id, 'RB', null, 6, BYE[id] ?? null).outlook,
    })),
  })
  const squads = [
    squad('me', ['jones', 'gibbs', 'mason']),
    squad('b', ['taylor', 'hall', 'spears']),
    squad('c', ['taylor', 'hall', 'spears']),
  ]
  const weak = weakSpots(squads, { RB: 3 })
  assert.deepEqual(weak.get('me'), [],
    'two backs on their bye are still two of the best backs in the league')

  /*
   * And the same squads valued on week six alone — what the finder used to
   * do — to show the test is not asserting that nothing can ever be weak.
   */
  const onlySix = [table(6, w6)]
  const flat = squads.map((s) => ({
    ...s,
    players: s.players.map((p) => ({
      ...p, projected: levelOver(onlySix, p.id, 'RB', null, 6, null).outlook,
    })),
  }))
  assert.deepEqual(weakSpots(flat, { RB: 3 }).get('me'), ['RB'],
    'which is the answer the calendar used to give')
})
