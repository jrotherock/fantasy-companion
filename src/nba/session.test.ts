import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addManual, emptyDraft, ingestYahoo, undoManual } from './session.js'
import { NameIndex } from './join.js'
import { draftOrder, parseDraftResults, parseTeams } from './yahooDraft.js'
import { buildView, prepare } from './plan.js'
import { adpFor } from './draft.js'

const index = new NameIndex([
  { id: 'a', name: 'Alpha One', team: 'BOS' }, { id: 'b', name: 'Bravo Two', team: 'NYK' },
  { id: 'c', name: 'Charlie Three', team: 'LAL' }, { id: 'd', name: 'Delta Four', team: 'MIA' },
])
const order = ['Team A', 'Mine', 'Team C']
const row = (round: number, pickInRound: number, name: string) => ({ round, pickInRound, name })

test('the page lists teams in id order before the draft, so its order is not trusted until it carries picks', () => {
  const d = emptyDraft('x')
  ingestYahoo(d, [], order, 'Mine', 3, index)
  assert.equal(d.slot, null)
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index)
  assert.equal(d.slot, 2)
  assert.equal(d.slotSource, 'yahoo')
})

test('the API\'s order is trusted before the draft, because Yahoo only sends it once every seat is set', () => {
  const d = emptyDraft('x')
  ingestYahoo(d, [], order, 'Mine', 3, index, 0, 'api')
  assert.equal(d.slot, 2)
})

test('a typed pick stands until Yahoo reports that pick, then Yahoo\'s answer replaces it', () => {
  const d = emptyDraft('x')
  addManual(d, 'b', 'Bravo Two')
  assert.equal(d.picks[0].overall, 1)
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index)
  assert.deepEqual(d.picks.map((p) => [p.overall, p.playerId, p.source]), [[1, 'a', 'yahoo']])
})

test('each reader retracts only its own picks; one a pick behind does not erase the other\'s', () => {
  const d = emptyDraft('x')
  ingestYahoo(d, [row(1, 1, 'Alpha One'), row(1, 2, 'Bravo Two')], order, 'Mine', 3, index, 0, 'api')
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index, 0, 'page')
  assert.deepEqual(d.picks.map((p) => p.playerId), ['a', 'b'], 'the page is behind; the API\'s second pick stays')
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index, 0, 'api')
  assert.deepEqual(d.picks.map((p) => p.playerId), ['a'], 'the API itself took pick two back')
})

test('an empty snapshot has lost sight of the board, and retracts nothing', () => {
  const d = emptyDraft('x')
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index, 0, 'api')
  ingestYahoo(d, [], [], 'Mine', 3, index, 0, 'api')
  assert.equal(d.picks.length, 1)
})

test('undo takes back the last typed pick and never one of Yahoo\'s', () => {
  const d = emptyDraft('x')
  ingestYahoo(d, [row(1, 1, 'Alpha One')], order, 'Mine', 3, index)
  addManual(d, 'c', 'Charlie Three')
  assert.equal(undoManual(d)?.playerId, 'c')
  assert.equal(undoManual(d), null)
  assert.equal(d.picks.length, 1)
})

test('API draft results and seats parse from Yahoo\'s shapes', () => {
  const results = { fantasy_content: { league: [{ league_key: 'k' }, { draft_results: {
    0: { draft_result: { pick: 2, round: 1, team_key: 'k.t.2', player_key: '478.p.10094' } },
    1: { draft_result: { pick: 1, round: 1, team_key: 'k.t.5', player_key: '478.p.5352' } },
    2: { draft_result: { pick: 3, round: 1, team_key: 'k.t.1' } },
    count: 3,
  } }] } }
  assert.deepEqual(parseDraftResults(results).map((p) => [p.overall, p.playerKey]), [[1, '478.p.5352'], [2, '478.p.10094']], 'an unmade pick has no player and is skipped')
  const teams = (positions: (number | null)[]) => ({ fantasy_content: { league: [{}, { teams: Object.fromEntries(positions.map((dp, i) => [i, { team: [[{ team_key: `k.t.${i}` }, { name: `T${i}` }, [], { draft_position: dp }, { is_owned_by_current_login: i === 1 ? 1 : 0 }]] }])) }] } })
  assert.deepEqual(draftOrder(parseTeams(teams([2, 1, 3]))), ['T1', 'T0', 'T2'])
  assert.deepEqual(draftOrder(parseTeams(teams([2, null, 3]))), [], 'a partial order is not an order')
  assert.equal(parseTeams(teams([1, 2, 3]))[1].mine, true)
})

test('the screen keeps never-list players on the board and out of the advice, and reads no build early', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const jokic = players.find((p: any) => p.name === 'Nikola Jokić').id
  const d = emptyDraft('nba-hoops')
  d.slot = 1
  const view = buildView(hoops, d, new Map([[jokic, 'never' as const]]))
  assert.equal(view.clock.onClock, true)
  assert.ok(!view.advice.some((a) => a.id === jokic))
  assert.ok(view.board.find((r) => r.id === jokic)?.tag === 'never')
  assert.equal(view.build?.stage, 'open')
  assert.ok(view.paths.length > 1 && view.ahead.length > 0)

  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const pv = buildView(harker, { ...emptyDraft('nba-harker'), slot: 3 }, new Map())
  assert.equal(pv.build, null, 'a points league has no build')
  assert.equal(pv.paths.length, 1)
})
