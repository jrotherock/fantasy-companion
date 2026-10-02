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

import { backtestHabits } from './opponents.js'

/**
 * Synthetic league-seasons: 10 managers, 13 rounds, 130 players with ADP in
 * order. With `habit`, managers 0-2 take the best point guard left in the first
 * six rounds and 3-5 the best centre; without it everyone takes the best ADP.
 */
function synth(seasons: number, habit: boolean): HistSeason[] {
  const out: HistSeason[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let y = 0; y < seasons; y++) {
    const pool = Array.from({ length: 130 }, (_, i) => ({ adp: i + 1 + rnd() * 6, positions: i % 3 === 0 ? ['PG'] : i % 3 === 1 ? ['C'] : ['SF'] }))
      .sort((a, b) => a.adp - b.adp)
    const picks: HistPick[] = []
    for (let n = 1; n <= 130; n++) {
      const round = Math.ceil(n / 10), seat = round % 2 ? (n - 1) % 10 : 9 - ((n - 1) % 10)
      let i = 0
      // Habits are a lean, not a rule: they win when the player is close to the top of the board.
      if (habit && round <= 6 && seat < 6 && rnd() < 0.7) {
        const want = seat < 3 ? 'PG' : 'C'
        const j = pool.findIndex((p) => p.positions[0] === want)
        if (j >= 0 && j < 4) i = j
      }
      const p = pool.splice(i, 1)[0]
      picks.push({ pick: n, round, manager: `m${seat}`, positions: p.positions, adp: p.adp })
    }
    out.push({ season: String(2010 + y), teams: 10, picks })
  }
  return out
}

test('the backtest finds planted habits and does not invent them', () => {
  const t0 = Date.now()
  const planted = backtestHabits(synth(7, true))
  const none = backtestHabits(synth(7, false))
  assert.equal(planted.verdict, 'habits help')
  assert.ok(planted.habits.logloss < planted.adp.logloss)
  assert.notEqual(none.verdict, 'habits help')
  assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`)
})
