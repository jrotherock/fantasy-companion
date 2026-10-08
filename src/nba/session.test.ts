import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addManual, emptyDraft, ingestYahoo, undoManual } from './session.js'
import { NameIndex } from './join.js'
import { draftOrder, parseDraftResults, parseTeams } from './yahooDraft.js'
import { buildView, checkScoring, compareView, playoffTiebreak, prepare } from './plan.js'
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

test('a league with a Draft rank opens the board in tiers, by usual round inside each; one without keeps value order', () => {
  const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues
  const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
  const file = JSON.parse(readFileSync('data/nba/draft-rank/nba-hoops.json', 'utf8'))
  const hoops = prepare(leagues.find((l: any) => l.id === 'nba-hoops'), players, noise, adpFor, {}, null, {}, file)
  const d = emptyDraft('t'); d.slot = 5
  const v = buildView(hoops, d, new Map())
  const ranked = v.board.filter((r) => r.draftRank != null)
  assert.equal(ranked[0].name, file.players[0].name)
  assert.ok(ranked.every((r, i) => i === 0 || r.draftRank! > ranked[i - 1].draftRank!))
  const rd = (r: { adp: number | null }) => Math.ceil(hoops.adp(ranked.find((x) => x === r)!.id) / 10)
  assert.ok(ranked.every((r, i) => i === 0 || r.tier! > ranked[i - 1].tier! || (r.tier === ranked[i - 1].tier && rd(r) >= rd(ranked[i - 1]))), 'tiers, then the usual round inside each')
  assert.ok(v.board.findIndex((r) => r.draftRank == null) > ranked.length - 1, 'unranked players come after the ranked')
  assert.ok(v.board.some((r) => r.forMe === 0), 'the top card reads 0 for my team')
  const harker = prepare(leagues.find((l: any) => l.id === 'nba-harker'), players, noise, adpFor)
  const h = buildView(harker, { ...emptyDraft('t'), slot: 5 }, new Map())
  assert.ok(h.board.every((r) => r.draftRank == null))
  assert.ok(h.board.every((r, i) => i === 0 || r.rank >= h.board[i - 1].rank))
})
