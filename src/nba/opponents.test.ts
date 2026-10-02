import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseOpponents, seasonMetrics, type HistPick, type HistSeason } from './opponents.js'
import { draftManagers, parseTeams } from './yahooDraft.js'

/** A season where each manager takes `guards` point guards among their first six picks. */
function season(label: string, guards: Record<string, number>, reach: Record<string, number> = {}): HistSeason {
  const picks: HistPick[] = []
  let pick = 1
  for (let round = 1; round <= 8; round++) {
    for (const [m, g] of Object.entries(guards)) {
      picks.push({ pick, round, manager: m, positions: round <= g ? ['PG'] : ['SF'], adp: pick + (reach[m] ?? 0) })
      pick++
    }
  }
  return { season: label, teams: Object.keys(guards).length, picks }
}

const managers = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

test('one season\'s habits: point guards in the first six, and how far ahead of ADP', () => {
  const m = seasonMetrics(season('x', { A: 3 }, { A: 5 }).picks)
  assert.equal(m.guardEarly, 0.5)
  assert.equal(m.reach, 5)
})

test('a habit that holds every season is called consistent; one that flips is not', () => {
  // Each manager's guard appetite is the same every year; their reach is reshuffled.
  const appetite = Object.fromEntries(managers.map((m, i) => [m, i % 4]))
  const shuffle = (k: number) => Object.fromEntries(managers.map((m, i) => [m, ((i * 3 + k * 5) % 7) - 3]))
  const r = analyseOpponents([season('2021', appetite, shuffle(1)), season('2022', appetite, shuffle(2)), season('2023', appetite, shuffle(3))])
  assert.equal(r.validation.guardEarly.consistent, true)
  assert.equal(r.validation.reach.consistent, false)
  const heavy = Object.entries(r.managers).find(([, p]) => p.habits.some((h) => h.metric === 'guardEarly'))!
  assert.ok(heavy[1].habits.find((h) => h.metric === 'guardEarly')!.consistent)
})

test('a manager Yahoo hides contributes nothing; seats follow draft position', () => {
  const json = (dp: (number | null)[], nick: string[]) => ({ fantasy_content: { league: [{}, { teams: Object.fromEntries(dp.map((d, i) => [i, { team: [[{ team_key: `k.t.${i}` }, { name: `T${i}` }, { draft_position: d }, { managers: [{ manager: { nickname: nick[i] } }] }]] }])) }] } })
  const teams = parseTeams(json([2, 1], ['Tony', '--hidden--']))
  assert.equal(teams[1].manager, null)
  assert.deepEqual(draftManagers(teams), [null, 'Tony'])
  assert.deepEqual(draftManagers(parseTeams(json([2, null], ['A', 'B']))), [], 'no order until every seat is set')
})

test('one person is one person however Yahoo capitalised them', () => {
  const r = analyseOpponents([season('2021', { thomas: 2, B: 1 }), season('2022', { Thomas: 2, B: 1 })])
  assert.equal(r.managers.thomas.seasons, 2)
  assert.equal(r.managers.Thomas, undefined)
})
