import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addManual, emptyDraft, ingestYahoo, undoManual } from './session.js'
import { NameIndex } from './join.js'
import { draftOrder, parseDraftResults, parseTeams } from './yahooDraft.js'
import { buildView, checkScoring, compareView, playoffTiebreak, prepare, urgencyOf, injuryHistoryOf, puntTipFor, emptySeatShare, seatFillFor, simTiebreak, orderTiebreak, stashNote, healthRiskOf } from './plan.js'
import { applyAdjustments, resolvePreferences } from './preferences.js'
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

test('the punt tip follows the first pick, from the 2nd pick to the 4th, and never over a lock', () => {
  const edwards = puntTipFor('Anthony Edwards', 1, [])
  assert.equal(edwards?.cat, 'ast')
  assert.equal(edwards?.even, false)
  assert.equal(puntTipFor('Victor Wembanyama', 2, [])?.even, true, 'a tie is offered as a tie')
  assert.equal(puntTipFor('Tyrese Maxey', 3, [])?.cat, 'fg')
  assert.equal(puntTipFor('Tyrese Maxey', 4, []), null, 'gone from the 4th pick on')
  assert.equal(puntTipFor('Tyrese Maxey', 1, ['reb']), null, 'not over a lock')
  assert.equal(puntTipFor('Nikola Jokić', 1, []), null, 'no tip where the cards already win')
  assert.equal(puntTipFor(null, 0, []), null)

  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const ant = players.find((p: any) => p.name === 'Anthony Edwards').id
  const d = emptyDraft('nba-hoops')
  d.slot = 7
  d.picks = Array.from({ length: 7 }, (_, i) => ({ overall: i + 1, playerId: i === 6 ? ant : players.filter((p: any) => p.id !== ant && p.yahoo)[i].id, name: '', source: 'manual' as const }))
  assert.equal(buildView(hoops, d, new Map()).build?.puntTip?.cat, 'ast')
})

test('a starting spot nobody can fill is flagged, with the steady player near the top who fills it', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const games = JSON.parse(readFileSync('data/nba/schedule.json', 'utf8')).games as { date: string; home: string; away: string }[]
  const teamDates: Record<string, string[]> = {}
  for (const g of games) for (const t of [g.home, g.away]) (teamDates[t] ??= []).push(g.date)
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor, {}, { returns: new Map(), teamDates, today: '2026-10-11' })
  const id = (n: string) => players.find((p: any) => p.name === n).id
  const guards = ['Tyrese Haliburton', 'James Harden', 'Derrick White', 'Tyler Herro', 'Jalen Suggs'].map(id)
  assert.equal(emptySeatShare(hoops, guards).get('C'), 1, 'no center: the C seat is empty every night')
  const one = emptySeatShare(hoops, [...guards, id('Myles Turner')]).get('C')!
  const two = emptySeatShare(hoops, [...guards, id('Myles Turner'), id('Brook Lopez')]).get('C')!
  assert.ok(one > 0.3 && one < 0.8 && two < one, `one center ${one}, two ${two}`)
  // Adding anyone never empties a seat he cannot touch (sampled draws used to: Buzelis read PG 70% → 66%).
  const before = emptySeatShare(hoops, [...guards, id('Myles Turner')]), after = emptySeatShare(hoops, [...guards, id('Myles Turner'), id('Matas Buzelis')])
  for (const [seat, v] of before) assert.ok(after.get(seat)! <= v + 1e-12, `${seat}: ${v} → ${after.get(seat)}`)
  const advice = [{ id: id('Jamal Murray'), name: 'Jamal Murray', score: 5 }, { id: id('Myles Turner'), name: 'Myles Turner', score: 4.98 }]
  const f = seatFillFor(hoops, guards, advice)
  assert.equal(f?.name, 'Myles Turner')
  assert.equal(f?.seat, 'C')
  assert.equal(seatFillFor(hoops, guards, [advice[0], { ...advice[1], score: 4.9 }]), null, 'not when he is well behind the top')
  assert.equal(seatFillFor(hoops, guards.slice(0, 4), advice), null, 'not before the 6th pick')
  // With FG% punted, two centers are enough for one C seat: no flag for a third.
  const twoBigs = [...guards.slice(0, 3), id('Myles Turner'), id('Brook Lopez')]
  const third = [{ id: id('Jamal Murray'), name: 'Jamal Murray', score: 5 }, { id: id('Nic Claxton'), name: 'Nic Claxton', score: 4.99 }]
  assert.equal(seatFillFor(hoops, twoBigs, third, false, ['fg'])?.seat === 'C', false, 'no third center under a punt of FG%')
})

test("the sims' tiebreak moves the star only within its band (0.06, or 25% in points), among the equally urgent, never to an avoid", () => {
  const sim = (delta: number) => ({ rank: 1, mark: null, sim: { delta, err: 1.8 } })
  const prep: any = { cats: {}, draftRank: new Map([['a', sim(-3)], ['b', sim(-1)], ['c', sim(2)], ['d', sim(4)], ['e', sim(5)]]) }
  const p = (id: string, score: number, urgent = 0, tag: string | null = null) => ({ id, name: id.toUpperCase(), score, urgent, tag })
  const cards = [p('a', 5), p('b', 4.97), p('x', 4.9)]
  const pool = [...cards, p('c', 4.95, 1), p('d', 4.99, 0, 'avoid'), p('e', 4.93)]
  const r = simTiebreak(prep, cards, pool, (a) => a.urgent)
  assert.equal(r.advice[0].id, 'b', 'e is 0.07 back, c is less urgent, d is an avoid: b, the next best in the sims')
  assert.equal(r.note?.over, 'A')
  assert.equal(r.advice.length, 3)
  assert.equal(simTiebreak(prep, [p('e', 5), p('a', 4.99)], [p('e', 5), p('a', 4.99)], () => 0).note, null, 'no move when the top card leads the sims')
  // Points: the band is a share of the top score (25%), so a player well behind in points can still take it.
  const ptsRank = new Map([['a', sim(-3)], ['b', sim(2)], ['e', sim(5)]])
  const pts = simTiebreak({ cats: null, draftRank: ptsRank } as any, [p('a', 1000), p('b', 900)], [p('a', 1000), p('b', 900), p('e', 700)], () => 0)
  assert.equal(pts.advice[0].id, 'b', 'e is 30% back: outside; b, 10% back and clearly ahead in the sims (5 ± 2.5), takes it')
  // Points: an edge inside its own error does not move the star (b's edge over a is 2 ± 2.5).
  const close = simTiebreak({ cats: null, draftRank: new Map([['a', sim(-3)], ['b', sim(-1)]]) } as any, [p('a', 1000), p('b', 950)], [p('a', 1000), p('b', 950)], () => 0)
  assert.equal(close.note, null, 'a coin flip keeps the higher-value card')
  // A player with your own numbers is out of the sims' reach, on either side.
  const mineRank = new Map([['a', sim(-3)], ['b', sim(5)]])
  assert.equal(simTiebreak({ cats: {}, draftRank: mineRank, adjusted: new Set(['b']) } as any, [p('a', 5), p('b', 4.99)], [p('a', 5), p('b', 4.99)], () => 0).note, null)
  assert.equal(simTiebreak({ cats: {}, draftRank: mineRank, adjusted: new Set(['a']) } as any, [p('a', 5), p('b', 4.99)], [p('a', 5), p('b', 4.99)], () => 0).note, null)
})

test('your ranking takes the star among near-ties only, over the sims and unlisted players alike', () => {
  const prep: any = { cats: {}, myOrder: ['t', 'm', 'e'] }
  const p = (id: string, score: number, urgent = 0, tag: string | null = null) => ({ id, name: id.toUpperCase(), score, urgent, tag })
  // Your view: Haliburton (h, unlisted here) tops the cards, Maxey and Tatum within 0.05.
  const cards = [p('h', 5), p('m', 4.955), p('t', 4.95)]
  const r = orderTiebreak(prep, cards, [...cards, p('e', 4.93)], (a) => a.urgent)
  assert.equal(r.advice[0].id, 't', 'Tatum, first on your list and 0.05 back, takes it')
  assert.equal(r.note?.over, 'H')
  assert.ok(Math.abs(r.note!.behind - 0.05) < 1e-9)
  assert.equal(r.advice.length, 3)
  // Too far back: the cards stand.
  const far = [p('m', 5), p('t', 4.86)]
  assert.equal(orderTiebreak(prep, far, far, () => 0).note, null, 'Tatum 0.14 back stays behind Maxey')
  // Less urgent (likely back next turn): not this pick's choice.
  assert.equal(orderTiebreak(prep, [p('m', 5)], [p('m', 5), p('t', 4.99, 1)], (a) => a.urgent).note, null)
  // An avoid never takes it, and an empty list changes nothing.
  assert.equal(orderTiebreak(prep, [p('m', 5)], [p('m', 5), p('t', 4.99, 0, 'avoid')], () => 0).note, null)
  assert.equal(orderTiebreak({ cats: {}, myOrder: [] } as any, cards, cards, () => 0).note, null)
  // Already first on your list: no note.
  assert.equal(orderTiebreak(prep, [p('t', 5), p('m', 4.99)], [p('t', 5), p('m', 4.99)], () => 0).note, null)
  // Points: within 5% of the best card only (the sims' 25% would lift a listed player over clearly better ones).
  const pts: any = { cats: null, myOrder: ['g'] }
  assert.equal(orderTiebreak(pts, [p('b', 1000)], [p('b', 1000), p('g', 960)], () => 0).advice[0].id, 'g', '4% back: your pick')
  assert.equal(orderTiebreak(pts, [p('b', 1000)], [p('b', 1000), p('g', 900)], () => 0).note, null, '10% back: the cards stand')
})

test('a league view: its own order and expected stats, kept out of other leagues', () => {
  const idx = new NameIndex([{ id: 'm', name: 'Tyrese Maxey', team: 'PHI' }, { id: 't', name: 'Jayson Tatum', team: 'BOS' }])
  const file = { leagues: { 'nba-hoops': { order: ['Jayson Tatum', 'Tyrese Maxey', 'Nobody Here'], adjust: { 'Tyrese Maxey': { ast: 4.8, fgPct: 0.45, fga: 18 } } } } }
  const hoops = resolvePreferences(file, 'nba-hoops', idx)
  assert.deepEqual(hoops.order, ['t', 'm'])
  assert.deepEqual(hoops.unresolved, ['Nobody Here'])
  const other = resolvePreferences(file, 'nba-harker', idx)
  assert.deepEqual(other.order, [])
  assert.equal(other.adjust.size, 0)
  const players: any[] = [
    { id: 'm', name: 'Tyrese Maxey', projection: { perGame: { pts: 25.8, ast: 5.9 }, shooting: { fgPct: 0.467, ftPct: 0.887 } } },
    { id: 't', name: 'Jayson Tatum', projection: { perGame: { pts: 26.4, ast: 5.5 }, shooting: { fgPct: 0.451 } } },
  ]
  const out = applyAdjustments(players, hoops.adjust)
  assert.equal(out[0].projection!.perGame.ast, 4.8)
  assert.equal(out[0].projection!.perGame.pts, 25.8, 'what you did not set stays')
  assert.equal(out[0].projection!.shooting.fgPct, 0.45, 'fgPct goes to shooting')
  assert.equal((out[0].projection!.shooting as any).fga, 18, 'so do attempts')
  assert.equal((out[0].projection!.perGame as any).fga, undefined)
  assert.equal(players[0].projection.perGame.ast, 5.9, 'the shared players are not changed in place')
  assert.equal(out[1], players[1], 'others untouched')
  const g = applyAdjustments([{ id: 'p', name: 'Paul George', projection: { perGame: { pts: 17 }, shooting: {}, gp: 63, gpSource: 'fantasypros' } }] as any, new Map([['p', { gp: 60, pts: 18 }]]))
  assert.equal(g[0].projection!.gp, 60)
  assert.equal(g[0].projection!.gpSource, 'you', 'your games are taken as given, not blended with history')
  assert.equal((g[0].projection!.perGame as any).gp, undefined)
})

test('a health risk: 60 games or fewer, or a season mostly lost', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const id = (n: string) => players.find((p: any) => p.name === n).id
  assert.ok(healthRiskOf(hoops, id('Ja Morant')), 'about 50 games')
  assert.equal(healthRiskOf(hoops, id('Trae Young'))?.lost, true, 'played under 25 games last season')
  assert.equal(healthRiskOf(hoops, id('Tyrese Maxey')), null)
  assert.equal(healthRiskOf(hoops, id('Cooper Flagg')), null, 'a second-year player with a full rookie season')
})

test('a late returner is an IL stash while the league has IL seats free, and says so when they are taken', () => {
  const harker: any = { league: { roster: { IL: 2 } }, weeksOut: (id: string) => (id === 'short' ? 1 : 5) }
  const note = 'Back ~Nov 11 (CBS: at least Nov 1) · 54 games'
  assert.match(stashNote(harker, note, 0)!, /stash him on IL \(1 of 2\)/)
  assert.match(stashNote(harker, note, 2)!, /IL seats are spoken for: he'd hold a bench seat/)
  assert.equal(stashNote({ league: { roster: {} } } as any, note, 0), note, 'no IL seats: the plain note')
  assert.equal(stashNote(harker, null, 0), null)
  assert.equal(stashNote(harker, note, 0, 'short'), note, 'a week out is a bench call: the plain note')
  assert.match(stashNote(harker, note, 0, 'long')!, /stash him on IL/)
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
  // A projection above his history (74 of 82 against 0.85 played) keeps the board's rate after a short absence:
  // the games he is valued at everywhere else, the projection blended with his history.
  const steady: any = { ...p, durability: { gpShare: 0.85 }, projection: { ...p.projection, gp: 74 } }
  const back = gamesAfterReturn(steady, { returnDate: '2027-01-01', outForSeason: false, source: 'you', text: '' }, dates, '2026-10-02').gp
  assert.ok(Math.abs(back - 4 * ((74 + 0.85 * 82) / 2 / 82)) < 1e-9, `${back}`)
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

test('off the clock, in both formats, the cards are players likely there at my pick', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  for (const [id, slot] of [['nba-harker', 5], ['nba-hoops', 8]] as const) {
    const prep = prepare(leagues.find((l: any) => l.id === id), players, noise, adpFor)
    const v = buildView(prep, { ...emptyDraft('t'), slot }, new Map())
    assert.equal(v.clock.onClock, false)
    assert.equal(v.takeNow.length, 3, id)
    assert.ok(v.takeNow.every((a) => a.there != null && a.there >= 0.5), `${id}: ${v.takeNow.map((a) => `${a.name} ${a.there}`)}`)
    // The best player on the board goes first and is not offered at pick 5 or 8.
    assert.ok(!v.takeNow.some((a) => a.id === prep.adpOrder[0]), id)
  }
})

test('on the clock in a points league, the playoff note speaks only of the cards', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  for (const at of [4, 27, 36, 59]) {
    const d = { ...emptyDraft('t'), slot: 5 }
    d.picks = harker.adpOrder.slice(0, at).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
    const v = buildView(harker, d, new Map())
    assert.equal(v.clock.onClock, true)
    assert.ok(v.takeNow.every((a) => a.there == null))
    if (v.playoffNote) for (const w of v.canWait) assert.ok(!v.playoffNote.includes(w.name), v.playoffNote)
  }
})

test('a player out for the season is never advised, however late — in both formats', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  for (const [id, slot, at] of [['nba-hoops', 4, 123], ['nba-harker', 5, 123]] as const) {
    const base = prepare(leagues.find((l: any) => l.id === id), players, noise, adpFor)
    // The best player still on the board at this pick, made out for the season.
    const d0 = { ...emptyDraft('t'), slot }
    d0.picks = base.adpOrder.slice(0, at).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
    const before = buildView(base, d0, new Map())
    assert.equal(before.clock.onClock, true, `${id} on the clock at ${at + 1}`)
    const star = before.takeNow[0].id
    const name = players.find((p: any) => p.id === star).name
    const returns = new Map([[star, { returnDate: null, outForSeason: true, source: 'cbs' as const, text: 'Out for the season' }]])
    const hurt = prepare(leagues.find((l: any) => l.id === id), players, noise, adpFor, {}, { returns, teamDates: {}, today: '2026-10-02' })
    const after = buildView(hurt, d0, new Map())
    assert.ok(!after.advice.some((a) => a.id === star), `${id}: ${name} is out for the season and was still advised`)
    assert.ok(after.board.some((r) => r.id === star), `${id}: he stays on the board`)
  }
})

test('a points mock places my roster against every team\'s season points total', async () => {
  const { recordOf } = await import('./plan.js')
  const { slotFor } = await import('../kernel/snake.js')
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const prep = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const d = { ...emptyDraft('t'), slot: 5 }
  d.picks = prep.adpOrder.slice(0, 16 * prep.rounds).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  const r = recordOf(prep, d, new Map())!
  // By hand: each seat's season points, from its own picks.
  const totals = new Map<number, number>()
  for (const x of d.picks) totals.set(slotFor(x.overall, 16), (totals.get(slotFor(x.overall, 16)) ?? 0) + (prep.points!.byId.get(x.playerId)?.season ?? 0))
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
  assert.equal(r.place!.of, 16)
  assert.equal(r.place!.fpSeason, sorted.findIndex(([seat]) => seat === 5) + 1)
  assert.ok(Math.abs(r.fpSeason! - totals.get(5)!) < 1e-6)
  assert.ok(r.place!.result >= 1 && r.place!.result <= 16)
})

test('after Shai the cards say which close categories each moves and what it stacks', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const sga = players.find((p: any) => p.name === 'Shai Gilgeous-Alexander').id
  const d = { ...emptyDraft('t'), slot: 3 }
  // Shai at 3, then the room picks by ADP to my next turn (pick 18 in a 10-team snake).
  const rest = hoops.adpOrder.filter((id) => id !== sga)
  d.picks = Array.from({ length: 17 }, (_, i) => ({ overall: i + 1, playerId: i === 2 ? sga : rest[i < 2 ? i : i - 1], name: '', source: 'manual' as const }))
  const v = buildView(hoops, d, new Map())
  assert.equal(v.clock.onClock, true)
  assert.ok(v.weakSpots && v.weakSpots.whose.endsWith("'s"))
  // Close categories are those still in play (35-65%); after one star nothing is far from a coin flip yet.
  assert.ok(v.weakSpots!.cats.some((c) => ['reb', 'blk', 'tpm'].includes(c)), `close: ${v.weakSpots!.cats}`)
  assert.ok(v.strongSpots.every((c) => !v.weakSpots!.cats.includes(c)))
  assert.ok(v.takeNow.every((a) => Array.isArray(a.fits) && Array.isArray(a.stacks)))
  // Locking a punt takes it off the weak spots: going guard-heavy stops the push toward bigs.
  const leaning = buildView(hoops, { ...d, locks: ['reb', 'blk'] }, new Map())
  assert.ok(!leaning.weakSpots?.cats.some((c) => c === 'reb' || c === 'blk'))
})

test('the playoff tiebreak never repeats or drops a card when the cards are not in score order', () => {
  const a = (name: string, score: number, playoff: number) => ({ name, score, playoff })
  // As the cards come: Kyrie and Bane too close to call, with Wagner between them (he will be gone sooner).
  const cards = [a('Kyrie', 5.0, 9), a('Wagner', 4.8, 10), a('Bane', 4.99, 12)]
  const tb = playoffTiebreak(cards, 0.02)
  const names = tb.advice.map((x) => x.name)
  assert.equal(new Set(names).size, 3, `repeated: ${names}`)
  assert.deepEqual([...names].sort(), ['Bane', 'Kyrie', 'Wagner'])
  assert.equal(names[0], 'Bane', 'more playoff games breaks the tie')
})

test('the playoff tiebreak never lifts a player who can wait over one who will not last', () => {
  const a = (name: string, score: number, playoff: number, canWait: boolean) => ({ name, score, playoff, canWait })
  // The 2026-10-08 mock, round 12: Green will be gone; Maluach scores higher but is 93% back next turn.
  const cards = [a('Green', 5.407, 10, false), a('Maluach', 5.48, 11, true), a('VanVleet', 5.481, 10, true)]
  assert.equal(playoffTiebreak(cards, 0.02, (x) => x.canWait).advice[0].name, 'Green')
  assert.equal(playoffTiebreak([a('Up', 5.0, 9, false), a('Above', 5.015, 12, false)], 0.02).advice[0].name, 'Above', 'close on either side, same group')
})

test('the playoff tiebreak never lifts a coin flip over a player who will be gone', () => {
  // The 2026-10-08 slot-1 mock, pick 101: Quickley 89% gone, Maluach 55% back, 0.013 apart, Maluach one more playoff game.
  const a = (name: string, score: number, playoff: number, survives: number) => ({ name, score, playoff, canWait: false, survives })
  const cards = [a('Quickley', 5.0, 10, 0.11), a('Maluach', 4.987, 11, 0.55), a('Turner', 4.983, 10, 0.17)]
  assert.equal(playoffTiebreak(cards, 0.02, (x) => urgencyOf(x.canWait, x.survives)).advice[0].name, 'Quickley')
})

test('the playoff tiebreak never lifts a player much likelier to be back than the card he passes', () => {
  // The 2026-10-08 slot-9 mock, pick 52: Garland 29% back and the better score; Lillard 53% back, one more playoff game.
  const a = (name: string, score: number, playoff: number, survives: number) => ({ name, score, playoff, canWait: false, survives })
  const cards = [a('Garland', 4.452, 10, 0.29), a('Lillard', 4.433, 11, 0.53), a('Herro', 4.44, 9, 0.53)]
  const urgent = (x: { canWait: boolean; survives: number }) => urgencyOf(x.canWait, x.survives)
  assert.equal(playoffTiebreak(cards, 0.02, urgent, (x) => x.survives).advice[0].name, 'Garland')
  assert.equal(playoffTiebreak([a('Garland', 4.452, 10, 0.29), a('Twin', 4.44, 11, 0.35)], 0.02, urgent, (x) => x.survives).advice[0].name, 'Twin', 'within 10 points it still breaks the tie')
})

test('compare: a player off the cards is scored on the cards\' own scale, with a verdict in words', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  for (const id of ['nba-hoops', 'nba-harker']) {
    const prep = prepare(leagues.find((l: any) => l.id === id), players, noise, adpFor)
    const d = emptyDraft('t')
    d.slot = 3
    d.picks = prep.adpOrder.slice(0, 2).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
    const v = buildView(prep, d, new Map())
    const top = v.takeNow[0]
    // Someone well down the list: not on the cards, but scored all the same.
    const far = prep.adpOrder[40]
    const c = compareView(prep, d, new Map(), [top.id, far], v.takeNow.map((a) => a.id))!
    assert.equal(c.sides.length, 2)
    assert.equal(c.sides[0].card, 1)
    assert.equal(c.sides[1].card, null)
    assert.ok(Number.isFinite(c.sides[1].score), id)
    assert.ok(Math.abs(c.sides[0].score - top.score) < 1e-9, 'the card keeps its own score')
    assert.ok(c.sides[0].score > c.sides[1].score)
    assert.ok(c.verdict.startsWith(top.name), c.verdict)
    if (id === 'nba-hoops') assert.match(c.verdict, /categor(y|ies) won over the season/)
    else assert.match(c.verdict, /fantasy points over the season/)
  }
})

test('a card names the players I already have from his NBA team', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const d = emptyDraft('t')
  d.slot = 1
  // My first pick, then the room down ADP to my second: whoever shares his team says so.
  d.picks = hoops.adpOrder.slice(0, 19).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  const v = buildView(hoops, d, new Map())
  const first = hoops.players.get(hoops.adpOrder[0])!
  for (const a of v.advice) assert.deepEqual(a.mates, a.team === first.team ? [first.name] : [], a.name)
})

test('a league with a Draft rank opens the board with the simulations\' top 5, then by usual round; one without keeps value order', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const file = JSON.parse(readFileSync('data/nba/draft-rank/nba-hoops.json', 'utf8'))
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor, {}, null, {}, file)
  const d = emptyDraft('t'); d.slot = 5
  const v = buildView(hoops, d, new Map())
  assert.deepEqual(v.board.slice(0, 5).map((r) => r.name), file.players.slice(0, 5).map((x: any) => x.name))
  assert.ok(v.board.slice(0, 5).every((r) => r.simTop) && !v.board[5].simTop)
  const ranked = v.board.filter((r) => r.draftRank != null)
  assert.ok(ranked.every((r, i) => i === 0 || r.draftRank! > ranked[i - 1].draftRank!))
  const rd = (r: { id: string }) => Math.ceil(hoops.adp(r.id) / 10)
  assert.ok(ranked.slice(5).every((r, i) => i === 0 || rd(r) >= rd(ranked[4 + i])), 'by usual round after the top 5')
  const off = v.board.findIndex((r) => r.draftRank == null)
  assert.ok(off === -1 || off > ranked.length - 1, 'players with no ADP come after')
  const mark = (name: string) => v.board.find((r) => r.name === name)?.simMark?.kind ?? null
  assert.equal(mark('Giannis Antetokounmpo'), 'down')
  assert.equal(mark('Trae Young'), 'down')
  assert.equal(mark('Anthony Edwards'), null)
  assert.equal(mark('Donovan Mitchell'), 'lean')
  assert.ok(v.board.some((r) => r.forMe === 0), 'the top card reads 0 for my team')
  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const h = buildView(harker, { ...emptyDraft('t'), slot: 5 }, new Map())
  assert.ok(h.board.every((r) => r.draftRank == null))
  assert.ok(h.board.every((r, i) => i === 0 || r.rank >= h.board[i - 1].rank))
})

test('a near-tie shows the whole group, ordered by fit, the app\'s pick marked; never in points', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const maxey = [...hoops.players.values()].find((p) => p.name === 'Tyrese Maxey')!.id
  const before = hoops.adpOrder.filter((id) => id !== maxey).slice(0, 4)
  const rest = hoops.adpOrder.filter((id) => id !== maxey && !before.includes(id))
  const d = emptyDraft('t'); d.slot = 5
  d.picks = [...before, maxey, ...rest.slice(0, 10)].map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  const v = buildView(hoops, d, new Map())
  assert.ok(v.tied && v.tied.players.length >= 3 && v.tied.players.length <= 6, 'round 2 at slot 5 is a near-tie')
  assert.equal(v.tied!.with, 'Tyrese Maxey')
  assert.equal(v.tied!.players.filter((x) => x.appPick).length, 1)
  assert.equal(v.tied!.players.find((x) => x.appPick)!.id, v.takeNow[0].id)
  assert.ok(v.tied!.players.every((x) => Math.abs(v.takeNow[0].score - v.advice.find((a) => a.id === x.id)!.score) <= 0.06 + 1e-9 && x.behind >= 0 && !x.canWait))
  const u = v.tied!.players.map((x) => (x.canWait ? 2 : x.survives <= 0.25 ? 0 : 1))
  assert.ok(u.every((x, i) => i === 0 || x >= u[i - 1]), 'likely gone first, then coin flips, then those likely back')
  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const h = { ...emptyDraft('t'), slot: 5 }
  h.picks = harker.adpOrder.slice(0, 26).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  assert.equal(buildView(harker, h, new Map()).tied, null)
})

test('a scarce note marks a close category a card fills with one or no comparable helpers left; never in points or on a pair', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  let notes = 0
  for (const [slot, picks] of [[5, 15], [5, 35], [3, 22], [1, 39], [1, 60]] as const) {
    const d = emptyDraft('t'); d.slot = slot
    d.picks = hoops.adpOrder.slice(0, picks).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
    const v = buildView(hoops, d, new Map())
    const pair = v.clock.myNext != null && (slot === 1 && (picks + 1) % 20 === 0)
    for (const a of [...v.takeNow, ...(v.tied?.players ?? [])]) {
      if (!a.scarce) continue
      notes++
      assert.ok(!pair, 'never on the first of a back-to-back pair')
      assert.ok(a.scarce.left <= 1 && a.scarce.names.length === a.scarce.left)
      const card = v.advice.find((x) => x.id === a.id)!
      assert.ok(card.fits.includes(a.scarce.cat) && card.contrib![a.scarce.cat] >= 1)
    }
  }
  assert.ok(notes > 0, 'it says something somewhere in these turns')
  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const h = { ...emptyDraft('t'), slot: 5 }
  h.picks = harker.adpOrder.slice(0, 26).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  assert.ok(buildView(harker, h, new Map()).takeNow.every((a) => !a.scarce))
})

test('an injury history tag shows a player who has missed a lot of games, with the games the cards count him for', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor)
  const id = (n: string) => players.find((p: any) => p.name === n).id
  const davis = injuryHistoryOf(hoops, id('Anthony Davis'))!
  assert.deepEqual(davis.seasons.map((s) => s.gp), players.find((p: any) => p.name === 'Anthony Davis').history.slice(-3).map((h: any) => h.gp))
  assert.equal(davis.counted, Math.round(hoops.cats!.byId.get(id('Anthony Davis'))!.games.gp))
  assert.equal(injuryHistoryOf(hoops, id('Derrick White')), null, 'a durable player has no tag')
  const rookie = players.find((p: any) => p.history?.length === 1)
  if (rookie) assert.equal(injuryHistoryOf(hoops, rookie.id), null, 'one season is a role, not a history')
})
