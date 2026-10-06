/**
 * The adapter between Yahoo's answers and the stores the features read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { YPlayer } from './yahooParse.js'

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'ff-ysync-'))
delete process.env.RAILWAY_ENVIRONMENT
const Y = await import('./yahooParse.js')
const S = await import('./yahooSync.js')
const leagueStore = await import('./yahooLeague.js')
const rosterStore = await import('./yahooRoster.js')

const F = JSON.parse(readFileSync('fixtures/yahoo-api.json', 'utf8'))
const node = (json: any, key: string) => Y.leagueNodes(json).find((n) => n.meta.league_key === key)!
const H2H = '470.l.1604981'
const CHOP = '470.l.310904'

/* ------------------------------------------------------------ discovery */

test('the four configs typed in August come out of Yahoo\'s settings unchanged', () => {
  /*
   * The strongest check there is on the league builder: four leagues were
   * configured by hand, and building each from what Yahoo says about it must
   * give the same slots, bench, reserve and scoring. Building Steward this way
   * is how its missing IR slot was found.
   */
  const leagues = Y.parseDiscovery(F.discovery)
  const files: Record<string, string> = {
    '310904': 'yahoo-guillotine', '582048': 'yahoo-green',
    '842228': 'yahoo-steward', '1604981': 'yahoo-h2h-1604981',
  }
  for (const [id, file] of Object.entries(files)) {
    const l = leagues.find((x) => x.id === id)!
    const built = S.configFrom(l, Y.parseSettings(node(F.settings, l.key).body)!, null) as any
    const typed = JSON.parse(readFileSync(`data/leagues/${file}.json`, 'utf8'))
    for (const k of ['teams', 'starters', 'flex', 'benchSize', 'rounds', 'scoring', 'irSlots', 'format']) {
      assert.deepEqual(built[k] ?? null, typed[k] ?? null, `${file}: ${k}`)
    }
  }
})

test('a league nobody configured gets a config, and says when it starts', () => {
  const death = Y.parseDiscovery(F.discovery).find((l) => l.id === '1667636')!
  const c = S.configFrom(death, Y.parseSettings(node(F.settings, death.key).body)!, '3') as any
  assert.equal(c.id, 'yahoo-1667636')
  assert.equal(c.myTeamId, '3')
  assert.equal(c.format, 'guillotine')
  assert.equal(c.startWeek, 2)
  assert.deepEqual(c.starters, { QB: 1, RB: 2, WR: 2, TE: 1 }, 'no kicker and no defence in this one')
  assert.equal(c.rounds, 14)
  assert.equal(c.scoring.rec, 0.5)
})

test('a stat Yahoo renumbered is not scored as whatever now holds its number', () => {
  const scoring = S.scoringFrom({
    positions: [], faab: false, waiverType: null, waiverRule: null, waiverDays: null,
    draftTime: null, playoffStartWeek: null,
    scored: [
      { id: '11', name: 'Receptions', group: 'O', value: 0.5 },
      { id: '12', name: 'Sack', group: 'DP', value: 6 },
      { id: '40', name: 'Sack', group: 'DT', value: 1 },
    ],
  })
  assert.deepEqual(scoring, { rec: 0.5 }, 'id 12 is not receiving yards when it is called Sack, and a team sack is not a defender\'s')
})

/* --------------------------------------------------------------- players */

const P = (id: string, name: string, pos: string, team: string, yahoo?: string) =>
  ({ id, name, pos, team, byeWeek: null, ids: yahoo ? { yahoo } : {} }) as any
const yp = (over: Partial<YPlayer>): YPlayer => ({
  key: '470.p.1', yahooId: '1', name: '', display: 'WR', primary: null, eligible: [],
  team: null, status: null, injury: null, slot: null, points: null, byeWeek: null, ...over,
})

test('a player is found by Yahoo\'s id first, then by name', () => {
  const resolve = S.resolver([P('a', 'Joe Flacco', 'QB', 'CIN', '8795'), P('b', 'Kaelon Black', 'RB', 'SF')])
  assert.equal(resolve(yp({ yahooId: '8795', name: 'Somebody Renamed', display: 'QB' }))?.id, 'a')
  assert.equal(resolve(yp({ yahooId: '42712', name: 'Kaelon Black', display: 'RB', team: 'SF' }))?.id, 'b')
})

test('the same name with a different Yahoo id is a different man', () => {
  const resolve = S.resolver([P('a', 'Mike Williams', 'WR', 'NYJ', '30150')])
  assert.equal(resolve(yp({ yahooId: '99999', name: 'Mike Williams', display: 'WR' })), null)
})

test('a defence is its club, and a defender is found through a compound position', () => {
  const resolve = S.resolver([
    P('min', 'Minnesota Vikings', 'DST', 'MIN'),
    P('lb', 'Jack Campbell', 'LB', 'DET'),
  ])
  assert.equal(resolve(yp({ name: 'Vikings', display: 'DEF', team: 'MIN' }))?.id, 'min')
  assert.equal(resolve(yp({ name: 'Jack Campbell', display: 'LB,DE', team: 'DET' }))?.id, 'lb')
})

test('a squad keeps who starts, and the names nobody could match', () => {
  const teams = Y.parseRosters(node(F.rosters, H2H).body)
  const resolve = S.resolver([P('b', 'Kaelon Black', 'RB', 'SF')])
  const [mine] = S.squadsFrom(teams.filter((t) => t.mine), resolve)
  assert.deepEqual(mine.players.map((p) => p.id), ['b'])
  assert.deepEqual(mine.starters, [], 'he is on the bench')
  assert.ok(mine.unmatched!.length > 0, 'everyone else is reported, not dropped silently')
  assert.equal(mine.players[0].projected, null, 'Yahoo gives no player projection to copy')
})

/* ----------------------------------------------------------------- moves */

test('a waiver move is one manager\'s, with what came and what went', () => {
  const txs = Y.parseTransactions(node(F.transactions, H2H).body)
  const moves = S.movesFrom(txs, new Map([['1', 'Manager 1'], ['6', 'Manager 6']]), () => null)
  const both = moves.find((m) => m.type === 'add/drop')!
  assert.equal(both.added.length, 1)
  assert.equal(both.dropped.length, 1)
  assert.match(both.manager, /^Manager \d+$|^A manager$/)
  assert.ok(both.added[0].id.startsWith('yahoo:'), 'an unmatched player keeps Yahoo\'s name and a marked id')
  assert.ok(moves.every((m, i) => i === 0 || moves[i - 1].at >= m.at), 'newest first')
})

test('a trade is one move for each side, from that side\'s point of view', () => {
  const player = (name: string) => yp({ name, yahooId: name })
  const moves = S.movesFrom([{
    key: 'tr.9', id: '9', type: 'trade', status: 'successful', at: 5, faabBid: null,
    players: [
      { player: player('A'), kind: 'trade', fromTeamId: '1', toTeamId: '2', toType: 'team', fromType: 'team' },
      { player: player('B'), kind: 'trade', fromTeamId: '2', toTeamId: '1', toType: 'team', fromType: 'team' },
    ],
  }], new Map([['1', 'One'], ['2', 'Two']]), () => null)
  const one = moves.find((m) => m.manager === 'One')!
  assert.deepEqual(one.added.map((p) => p.name), ['B'])
  assert.deepEqual(one.dropped.map((p) => p.name), ['A'])
  assert.equal(moves.length, 2)
})

test('a commissioner\'s action with nobody in it is not a move', () => {
  const txs = Y.parseTransactions(node(F.transactions, CHOP).body)
  const moves = S.movesFrom(txs, new Map(), () => null)
  assert.ok(!moves.some((m) => m.type === 'commish'))
})

/* ----------------------------------------------------------------- weeks */

test('a finished week gives every score and who played whom', () => {
  const read = S.weekFrom(Y.parseScoreboard(node(F.scoreboardWeek1, H2H).body)!, false)!
  assert.equal(read.week.week, 1)
  assert.equal(read.week.teams.length, 10)
  assert.equal(read.pairs!.length, 5)
})

test('a week still being played is not a result', () => {
  assert.equal(S.weekFrom(Y.parseScoreboard(node(F.scoreboard, H2H).body)!, false), null)
})

test('a guillotine week has scores and no draw', () => {
  const sb = Y.parseScoreboard(node(F.scoreboard, CHOP).body)!
  const done = { ...sb, matchups: sb.matchups.map((m) => ({ ...m, status: 'postevent' })) }
  const read = S.weekFrom(done, true)!
  assert.equal(read.pairs, null, 'every team against the chopping block is not a fixture list')
  const ids = read.week.teams.map((t) => t.teamId)
  assert.equal(new Set(ids).size, ids.length, 'the team on the block appears once, not once a row')
})

/* -------------------------------------------------------------- schedule */

test('a part is due when its clock has run, sooner with games on', () => {
  const now = 10 * 60 * 60_000
  const parts = Object.fromEntries(S.PARTS.map((p) => [p, { at: now - 11 * 60_000, tried: null, error: null }]))
  assert.deepEqual(S.due(parts, true, now), ['scoreboard', 'teams'])
  assert.deepEqual(S.due(parts, false, now), [])
  assert.deepEqual(S.due({}, false, now), S.PARTS, 'a part never run is always due')
})

test('a part that just failed waits before it is asked again', () => {
  const now = 10 * 60 * 60_000
  const parts = { scoreboard: { at: now - 60 * 60_000, tried: now - 60_000, error: 'yahoo 500' } }
  assert.ok(!S.due(parts, true, now).includes('scoreboard'), 'a minute after failing')
  assert.ok(S.due(parts, true, now + 10 * 60_000).includes('scoreboard'), 'its own ten minutes later')
})

/* ----------------------------------------------------------------- round */

const retag = (json: any, from: string, to: string) => JSON.parse(JSON.stringify(json).split(from).join(to))
const only = (json: any, keys: string[]) => {
  const j = structuredClone(json)
  const ls = j.fantasy_content.leagues
  const kept = Object.keys(ls).filter((k) => /^\d+$/.test(k)).map((k) => ls[k])
    .filter((l: any) => keys.includes(l.league[0].league_key))
  j.fantasy_content.leagues = { ...Object.fromEntries(kept.map((l: any, i: number) => [String(i), l])), count: kept.length }
  return j
}

function recording(without: string[] = []): string {
  const keys = [H2H, CHOP]
  const disc = structuredClone(F.discovery)
  const leagues = disc.fantasy_content.users['0'].user[1].games['0'].game[1].leagues
  const kept = Object.keys(leagues).filter((k) => /^\d+$/.test(k)).map((k) => leagues[k])
    .filter((l: any) => keys.includes(l.league[0].league_key))
  disc.fantasy_content.users['0'].user[1].games['0'].game[1].leagues =
    { ...Object.fromEntries(kept.map((l: any, i: number) => [String(i), l])), count: kept.length }
  const calls: Record<string, unknown> = {
    [S.PATHS.discover()]: disc,
    [S.PATHS.settings(keys)]: only(F.settings, keys),
    [S.PATHS.rosters(keys)]: F.rosters,
    // The same read narrowed to one league, for a round that was asked for one.
    [S.PATHS.rosters([H2H])]: only(F.rosters, [H2H]),
    [S.PATHS.standings(keys)]: only(F.standings, keys),
    [S.PATHS.transactions(keys)]: F.transactions,
    [S.PATHS.scoreboard(keys)]: F.scoreboard,
    [S.PATHS.scoreboard(keys, 1)]: F.scoreboardWeek1,
    // Week one again for the guillotine alone, which the trimmed fixture has no result for.
    [S.PATHS.scoreboard([CHOP], 1)]: only(F.scoreboardWeek1, [CHOP]),
    [S.PATHS.teamWeek(`${H2H}.t.5`, 2)]: F.teamWeek,
    [S.PATHS.teamWeek(`${CHOP}.t.5`, 2)]: retag(F.teamWeek, `${H2H}.t.5`, `${CHOP}.t.5`),
    // Week one as well: a finished week is read once, to grade the lineup after it.
    [S.PATHS.teamWeek(`${H2H}.t.5`, 1)]: F.teamWeek,
    [S.PATHS.teamWeek(`${CHOP}.t.5`, 1)]: retag(F.teamWeek, `${H2H}.t.5`, `${CHOP}.t.5`),
  }
  // The opponent's week: the same shape, his key, not mine.
  const sb = Y.parseScoreboard(node(F.scoreboard, H2H).body)!
  const game = sb.matchups.find((m) => m.sides.some((s) => s.teamKey === `${H2H}.t.5`))!
  const his = game.sides.find((s) => s.teamKey !== `${H2H}.t.5`)!.teamKey
  const theirs = retag(F.teamWeek, `${H2H}.t.5`, his)
  theirs.fantasy_content.team[0] = theirs.fantasy_content.team[0]
    .filter((p: any) => !(p && typeof p === 'object' && 'is_owned_by_current_login' in p))
  calls[S.PATHS.teamWeek(his, 2)] = theirs
  for (const p of without) delete calls[p]
  const file = join(process.env.STATE_DIR!, `rec-${without.length}.json`)
  writeFileSync(file, JSON.stringify({ recordedAt: 1, calls }))
  return file
}

const players = JSON.parse(readFileSync('data/players.json', 'utf8')).players

test('a round fills every store the dark features read', async () => {
  process.env.YAHOO_REPLAY = recording()
  const r = await S.round({ players, configured: [], live: true, now: Date.now() })
  assert.deepEqual(r.failed, [])
  assert.deepEqual(r.ran, S.PARTS)

  const h2h = leagueStore.forLeague('1604981')!
  assert.equal(h2h.myTeamId, '5')
  assert.ok(h2h.squads.length === 2 && h2h.squads.every((s) => s.players.length > 0), 'squads for the trade finder')
  assert.ok(h2h.transactions.length > 0, 'moves for the digest')
  assert.deepEqual(h2h.weeks.map((w) => w.week), [1], 'week one for all-play')
  assert.equal(h2h.draw[0].pairs.length, 5, 'and who played whom, for the luck split')
  assert.equal(h2h.current?.week, 2)

  assert.ok(h2h.mineWeeks?.some((x) => x.week === 1 && x.players.length > 0),
    'and my own lineup that week, to grade it by afterwards')

  const cap = rosterStore.rosterFor('1604981')!
  /*
   * Where each man sits, which only the API says. It decides who could replace
   * a questionable starter: a back is no cover for a receiver's slot.
   */
  assert.equal(Object.keys(cap.slotOf ?? {}).length, cap.starters.length, 'a slot for every starter')
  assert.ok(Object.values(cap.slotOf ?? {}).includes('W/R/T'), 'the flex by the name the league gives it')
  assert.ok(Object.values(cap.slotOf ?? {}).includes('DST'), 'and Yahoo\'s DEF as the config\'s DST')
  assert.ok(cap.opponent && cap.opponent.starters.length > 0, 'his lineup, for the versus rows')
  assert.ok(cap.opponentAt != null, 'stamped, so it counts as read')
  assert.equal(typeof cap.standing?.pointsAgainst, 'number', 'points against, which the team page never had')
  assert.ok(cap.totals?.opponentName, 'and his name on the scoreline')

  const chop = leagueStore.forLeague('310904')!
  assert.equal(chop.guillotine, true)
  assert.equal(chop.draw.length, 0, 'no draw in a guillotine league')
  assert.equal(rosterStore.rosterFor('310904')?.opponent ?? null, null, 'and no opponent')
})

test('a part that fails leaves what it read before, and the round goes on', async () => {
  const before = leagueStore.forLeague('1604981')!.transactions.length
  process.env.YAHOO_REPLAY = recording([S.PATHS.transactions([H2H, CHOP])])
  const r = await S.round({ players, configured: [], live: true, now: Date.now(), force: S.PARTS })
  assert.deepEqual(r.failed.map((f) => f.part), ['transactions'])
  assert.equal(r.stopped, null, 'a refused request is its own problem, not the round\'s')
  assert.ok(r.ran.includes('scoreboard') && r.ran.includes('teams'))
  assert.equal(leagueStore.forLeague('1604981')!.transactions.length, before, 'the digest keeps its last reading')
  assert.match(S.state().parts.transactions!.error!, /not in the recording/)
})

test('a lineup that cannot be read costs its own grade, not the week\'s scores', async () => {
  /*
   * The grade is an extra carried on the back of the history part. Yahoo
   * refusing one old team page must not cost the all-play table, which is
   * what the part is actually for.
   */
  /*
   * Back to a league with no grade yet, and no week one either — a week the
   * store already holds is never read again, so leaving it there would make
   * this test pass without the lineup call ever happening. The store never
   * clears a reading on purpose, so the file is the only way to say it.
   */
  const file = join(process.env.STATE_DIR!, 'yahoo-leagues.json')
  const store = JSON.parse(readFileSync(file, 'utf8'))
  for (const rec of Object.values<any>(store)) { delete rec.mineWeeks; rec.weeks = [] }
  writeFileSync(file, JSON.stringify(store))
  process.env.YAHOO_REPLAY = recording([
    S.PATHS.teamWeek(`${H2H}.t.5`, 1), S.PATHS.teamWeek(`${CHOP}.t.5`, 1),
  ])
  const r = await S.round({ players, configured: [], live: true, now: Date.now(), force: ['history'] })
  assert.deepEqual(r.failed, [], 'the part still succeeded')
  const h2h = leagueStore.forLeague('1604981')!
  assert.deepEqual(h2h.weeks.map((w) => w.week), [1], 'the week was scored anyway')
  assert.deepEqual(h2h.mineWeeks, [], 'and the lineup simply went ungraded')
})

test('a round for one league reads that league and leaves the others alone', async () => {
  /*
   * Opening a screen used to refresh every league behind it. The parts that
   * read a league at a time cost two requests each, so one tap spent nine and
   * threw four leagues' worth away — most of how a day's budget went.
   */
  process.env.YAHOO_REPLAY = recording()
  const before = rosterStore.rosterFor('310904')?.at ?? 0
  await new Promise((r) => setTimeout(r, 2))
  const r = await S.round({
    players, configured: [], live: true, now: Date.now(),
    force: ['rosters', 'teams'], only: ['1604981'],
  })
  assert.deepEqual(r.failed, [])
  assert.ok((rosterStore.rosterFor('1604981')?.at ?? 0) > before, 'the one asked for was read')
  assert.equal(rosterStore.rosterFor('310904')?.at ?? 0, before, 'and the other was not')
})

test('a new week makes the lineups we hold due again', async () => {
  /*
   * `teams` runs hourly with no games on, which is exactly when the week turns
   * and exactly when the next one is being set — so a Tuesday roster could sit
   * an hour behind, showing a man in the slot he held on Sunday.
   */
  process.env.YAHOO_REPLAY = recording()
  leagueStore.record({ yahooLeagueId: '1604981', current: { week: 1, at: 1 } as any })
  const st0 = S.state()
  st0.parts.teams = { at: Date.now(), tried: Date.now(), error: null }
  const r = await S.round({ players, configured: [], live: true, now: Date.now(), force: ['scoreboard'] })
  assert.deepEqual(r.failed, [])
  assert.equal(S.state().parts.teams?.at, null,
    'the week moved, so the lineups are asked for again')
})

test('a scoreline does not count as having read the lineup', async () => {
  /*
   * `at` moves whenever anything about the team is written, and the scoreboard
   * writes a scoreline through it every few minutes — so that clock looked
   * fresh while the lineup under it was an hour old, and the refresh that
   * would have corrected a benched man kept deciding nothing needed reading.
   */
  const before = rosterStore.rosterFor('1604981')!
  assert.ok(before.lineupAt, 'a lineup read stamps its own clock')
  await new Promise((r) => setTimeout(r, 2))
  rosterStore.recordFromApi({
    yahooLeagueId: '1604981', teamId: before.teamId,
    totals: { teamName: 'x', opponentName: 'y', mine: 1, theirs: 2, projectedMine: 3, projectedTheirs: 4 },
  })
  const after = rosterStore.rosterFor('1604981')!
  assert.ok(after.at > before.at, 'the scoreline is a fresh reading of something')
  assert.equal(after.lineupAt, before.lineupAt, 'but the lineup was not read again')
})

test('a configured league is not discovered twice', async () => {
  process.env.YAHOO_REPLAY = recording()
  const r = await S.round({
    players, live: true, now: Date.now(), force: ['settings'],
    configured: [{ leagueKey: H2H } as any],
  })
  assert.deepEqual(r.discovered.map((d) => d.leagueKey), [CHOP])
})
