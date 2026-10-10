import { test } from 'node:test'
import assert from 'node:assert/strict'
import { positionalSlots, stillFeasible, unfilled } from './lineup.js'
import { resolvePreferences } from './preferences.js'
import { NameIndex } from './join.js'

const hoops = { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 3, BN: 5, IL: 3 }

test('only positional slots constrain; Util, bench and IL take anyone', () => {
  assert.deepEqual(positionalSlots(hoops), ['PG', 'SG', 'SF', 'PF', 'C'])
  assert.deepEqual(positionalSlots({ G: 1, F: 2, Util: 2 }), ['G', 'F', 'F'])
})

test('a multi-position player is moved to free a seat', () => {
  // PG,SG first would take PG greedily; the matching moves him to SG so the pure PG fits.
  assert.equal(unfilled([['PG', 'SG'], ['PG']], ['PG', 'SG']), 0)
  assert.equal(unfilled([['C'], ['C'], ['C']], ['PG', 'SG', 'SF', 'PF', 'C']), 4)
})

test('a fifth centre is refused once the picks left cannot fill the other four seats', () => {
  const slots = positionalSlots(hoops)
  const centres = [['C'], ['C'], ['C'], ['C']]
  assert.equal(stillFeasible(centres, ['C'], slots, 4), true, 'four picks left can still find a PG, SG, SF and PF')
  assert.equal(stillFeasible(centres, ['C'], slots, 3), false)
  assert.equal(stillFeasible(centres, ['PG', 'SG'], slots, 3), true)
})

test('never outranks avoid and like, league lists add to the shared ones, and typos are reported', () => {
  const index = new NameIndex([
    { id: '1', name: 'Joel Embiid', team: 'PHI' },
    { id: '2', name: 'Kawhi Leonard', team: 'TOR' },
    { id: '3', name: 'Anthony Davis', team: 'WAS' },
  ])
  const prefs = resolvePreferences({
    never: ['Joel Embiid'], avoid: ['Joel Embiid', 'Antony Davis'], like: [],
    leagues: { 'nba-hoops': { like: ['Kawhi Leonard'] }, 'nba-harker': { never: ['Anthony Davis'] } },
  }, 'nba-hoops', index)
  assert.equal(prefs.tags.get('1'), 'never')
  assert.equal(prefs.tags.get('2'), 'like')
  assert.equal(prefs.tags.has('3'), false, "another league's list does not apply here")
  assert.deepEqual(prefs.unresolved, ['Antony Davis'])
})

test('what is still to fill names every seat that could be the open one', async () => {
  const { stillToFill } = await import('./lineup.js')
  const slots = ['PG', 'SG', 'SF', 'PF', 'C']
  // Tatum SF/PF, Maxey PG, Kawhi SG/SF/PF, Mobley PF/C: one seat open, and it could be SG, SF, PF or C — only PG is spoken for.
  const r = stillToFill([['SF', 'PF'], ['PG'], ['SG', 'SF', 'PF'], ['PF', 'C']], slots)
  assert.equal(r.count, 1)
  assert.deepEqual(r.options.sort(), ['C', 'PF', 'SF', 'SG'])
  // Without a big, the C is the only seat that can be open.
  const g = stillToFill([['PG'], ['PG', 'SG'], ['SF'], ['PF']], slots)
  assert.deepEqual(g, { count: 1, options: ['C'] })
  assert.deepEqual(stillToFill([['PG'], ['SG'], ['SF'], ['PF'], ['C']], slots), { count: 0, options: [] })
})

test('a pickup never drops a center the lineup needs for its nights: two C seats keep a third center', async () => {
  const { keepsSeatDepth } = await import('./adds.js')
  const { startingSeats } = await import('./week.js')
  const seats = startingSeats({ PG: 1, SG: 1, G: 1, SF: 1, PF: 1, F: 1, C: 2, Util: 2, BN: 3, IL: 3 })
  const roster = [['PG'], ['PG', 'SG'], ['PG', 'SG'], ['SF', 'PF'], ['PF', 'C'], ['C'], ['C'], ['SF', 'PF'], ['PF'], ['PG', 'SG']].map((eligible) => ({ eligible }))
  const without = (i: number) => roster.filter((_, k) => k !== i)
  assert.equal(keepsSeatDepth(roster, [...without(4), { eligible: ['PG', 'SG'] }], seats), false, 'Siakam for a guard leaves two centers for two C seats')
  assert.equal(keepsSeatDepth(roster, [...without(4), { eligible: ['C'] }], seats), true, 'a center for a center is fine')
  assert.equal(keepsSeatDepth(roster, [...without(0), { eligible: ['SF'] }], seats), true, 'a spare guard can go')
  assert.equal(keepsSeatDepth(roster, [...without(8), { eligible: ['PG', 'SG'] }], seats), true, 'a fourth forward can go for a guard: three forwards fill three forward seats')
  const hoops = startingSeats({ PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 3, BN: 5, IL: 3 })
  assert.equal(keepsSeatDepth(roster, [...without(4), { eligible: ['PG'] }], hoops), true, 'one C seat: three centers have spares')
})
