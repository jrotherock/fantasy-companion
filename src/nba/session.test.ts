import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addManual, emptyDraft, ingestYahoo, undoManual } from './session.js'
import { NameIndex } from './join.js'
import { draftOrder, parseDraftResults, parseTeams } from './yahooDraft.js'
import { buildView, checkScoring, playoffTiebreak, prepare } from './plan.js'
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

test('a league scoring anything the models cannot value fails loudly', () => {
  const base = { id: 'x', label: 'x', leagueKey: 'k', myTeamName: '', teams: 10, roster: {} }
  assert.doesNotThrow(() => checkScoring({ ...base, scoring: 'categories', categories: ['fg%', 'ft%', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'] }))
  assert.throws(() => checkScoring({ ...base, scoring: 'categories', categories: ['fg%', 'ft%', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'dd'] }), /standard nine/)
  assert.throws(() => checkScoring({ ...base, scoring: 'points', points: { pts: 1, dd: 2 } }), /dd/)
})

test('the playoff schedule breaks a tie and never overrules a clear gap', () => {
  const a = (name: string, score: number, playoff: number | null) => ({ name, score, playoff, tiebreak: false as boolean | undefined })
  const tie = playoffTiebreak([a('Nine', 5.01, 9), a('Twelve', 5.0, 12), a('Far', 4.5, 13)], 0.02)
  assert.deepEqual(tie.advice.map((x) => x.name), ['Twelve', 'Nine', 'Far'])
  assert.equal(tie.advice[0].tiebreak, true)
  assert.match(tie.note!, /Twelve plays 12 games/)
  const clear = playoffTiebreak([a('Nine', 5.1, 9), a('Twelve', 5.0, 12)], 0.02)
  assert.deepEqual(clear.advice.map((x) => x.name), ['Nine', 'Twelve'])
  assert.equal(clear.note, null)
  const same = playoffTiebreak([a('One', 5.0, 11), a('Two', 5.0, 11)], 0.02)
  assert.equal(same.note, null, 'nothing to say when the schedule does not separate them')
})

test('the review judges a pick against the advice less anyone on the never list', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const order = hoops.adpOrder
  const d = emptyDraft('t')
  d.slot = 1
  d.turns = {}
  d.picks = order.slice(0, 130).map((id, i) => ({ overall: i + 1, playerId: id, name: id, source: 'manual' as const }))
  // At my first pick the advice led with someone now on the never list; I took its second choice.
  const never = order[200], took = order[0]
  d.turns[1] = { at: 0, advice: [{ id: never, score: 5, survives: 0, canWait: false }, { id: took, score: 4.9, survives: 0, canWait: false }], locks: [], stage: 'open' }
  const view = buildView(hoops, d, new Map([[never, 'never' as const]]))
  assert.equal(view.review?.advisedPicks, 1)
  assert.equal(view.review?.followed, 1, 'taking the best player not on the never list is following the advice')
  assert.equal(view.neverCount, 1)
})

test('a hurt player is counted from when he is back, and CBS dates are pushed back', async () => {
  const { gamesAfterReturn, RETURN_SLIP_DAYS } = await import('./plan.js')
  const p: any = { team: 'GSW', durability: { gpShare: 0.9 }, projection: { gp: 70, gpSource: 'fantasypros', perGame: {}, shooting: {}, sources: [] } }
  const dates = { GSW: ['2026-12-01', '2027-01-05', '2027-01-20', '2027-02-10', '2027-03-01'] }
  const cbs = gamesAfterReturn(p, { returnDate: '2027-01-01', outForSeason: false, source: 'cbs', text: '' }, dates, '2026-10-02')
  assert.equal(RETURN_SLIP_DAYS, 10)
  assert.equal(cbs.gp, 3 * 0.9, 'Jan 5 falls inside the slip; Jan 20, Feb 10 and Mar 1 count')
  const mine = gamesAfterReturn(p, { returnDate: '2027-01-01', outForSeason: false, source: 'you', text: '' }, dates, '2026-10-02')
  assert.equal(mine.gp, 4 * 0.9, 'your own date is taken as given')
  assert.equal(gamesAfterReturn(p, { returnDate: null, outForSeason: true, source: 'cbs', text: '' }, dates, '2026-10-02').gp, 0)
})

test('the three cards are players to take now; those likely back next turn go to the plan', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const d = emptyDraft('t')
  d.slot = 8
  d.picks = hoops.adpOrder.slice(0, 7).map((id, i) => ({ overall: i + 1, playerId: id, name: id, source: 'manual' as const }))
  const v = buildView(hoops, d, new Map())
  assert.equal(v.takeNow.length, 3)
  const urgent = v.advice.filter((a) => !a.canWait).length
  assert.ok(v.takeNow.slice(0, Math.min(3, urgent)).every((a) => !a.canWait), 'a can-wait player only fills a card when fewer than three will be gone')
  assert.ok(v.canWait.every((w) => !v.takeNow.some((t) => t.name === w.name)))
})
