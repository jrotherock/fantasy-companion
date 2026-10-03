import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxOf, catsOf, emptyBox, parseGameWeeks, parseNbaScoreboard, parseRosterDay, parseSeasonSettings, type Box } from './yahooSeason.js'
import { daysFrom, projectWeek, seat, startingSeats, type Man } from './week.js'
import { categoryWeek, pointsWeek, race, weekOdds, type SideOutlook } from './matchup.js'

// Shapes as Yahoo sent them for a real 9-cat league (466.l.43113, week 10), names changed.
const stats = (v: Record<string, string>) => Object.entries(v).map(([stat_id, value]) => ({ stat: { stat_id, value } }))
const teamNode = (id: string, name: string, nick: string, box: Record<string, string>, won: string, extra: object[] = []) => ({
  team: [[{ team_key: `466.l.1.t.${id}` }, { team_id: id }, { name }, [], { waiver_priority: 2 }, { number_of_moves: 20 },
    { roster_adds: { coverage_type: 'week', coverage_value: 24, value: '3' } }, ...extra,
    { managers: [{ manager: { nickname: nick } }] }],
  { team_stats: { coverage_type: 'week', week: '10', stats: stats(box) },
    team_points: { coverage_type: 'week', week: '10', total: won },
    team_remaining_games: { coverage_type: 'week', week: '10', total: { remaining_games: 4, live_games: 1, completed_games: 30 } } }],
})
const scoreboard = {
  fantasy_content: { league: [{ league_key: '466.l.1' }, { scoreboard: { 0: { matchups: { 0: { matchup: {
    0: { teams: {
      0: teamNode('1', 'Alpha', 'Ann', { 9004003: '254/478', 5: '.531', 9007006: '123/161', 8: '.764', 10: '58', 12: '689', 15: '223', 16: '190', 17: '32', 18: '25', 19: '94' }, '5'),
      1: teamNode('4', 'Mine', 'Me', { 9004003: '217/433', 5: '.501', 9007006: '122/133', 8: '.917', 10: '69', 12: '625', 15: '192', 16: '125', 17: '37', 18: '19', 19: '72' }, '4', [{ is_owned_by_current_login: 1 }]),
      count: 2 } },
    week: '10', week_start: '2025-12-22', week_end: '2025-12-28', status: 'midevent', is_playoffs: '0', is_consolation: '0',
    stat_winners: [{ stat_winner: { stat_id: '5', winner_team_key: '466.l.1.t.1' } }, { stat_winner: { stat_id: '8', winner_team_key: '466.l.1.t.4' } },
      { stat_winner: { stat_id: '18', is_tied: '1' } }],
  } }, count: 1 } }, week: '10' } }] },
}

test('a category scoreboard reads into box lines, categories won, games left and add counters', () => {
  const [m] = parseNbaScoreboard(scoreboard)
  assert.equal(m.week, 10)
  assert.equal(m.start, '2025-12-22')
  const mine = m.sides.find((s) => s.mine)!
  assert.equal(mine.id, '4')
  assert.equal(mine.box!.fgm, 217)
  assert.equal(mine.box!.fga, 433)
  assert.equal(mine.box!.to, 72)
  assert.equal(mine.points, 4)
  assert.equal(mine.addsThisWeek, 3)
  assert.deepEqual(mine.games, { remaining: 4, live: 1, completed: 30 })
  assert.equal(m.leaders.fg, '1')
  assert.equal(m.leaders.ft, '4')
  assert.equal(m.leaders.blk, 'tie')
  // Percentages are rebuilt from makes, never read off Yahoo's rounded string.
  assert.ok(Math.abs(catsOf(mine.box!).fg - 217 / 433) < 1e-12)
})

test('a day\'s roster carries each player\'s slot that day and his line', () => {
  const day = parseRosterDay({ fantasy_content: { team: [
    [{ team_key: '466.l.1.t.4' }, { team_id: '4' }, { name: 'Mine' }, { is_owned_by_current_login: 1 }, { managers: [{ manager: { nickname: 'Me', is_current_login: '1' } }] }],
    { roster: { 0: { players: { 0: { player: [
      [{ player_key: '466.p.6169' }, { player_id: '6169' }, { name: { full: 'Guard One' } }, { editorial_team_abbr: 'CHA' }, { display_position: 'PG,SG' },
        { primary_position: 'PG' }, { eligible_positions: [{ position: 'PG' }, { position: 'SG' }, { position: 'Util' }] }],
      { selected_position: [{ coverage_type: 'date', date: '2026-01-14' }, { position: 'SG' }, { is_flex: 0 }] },
      { is_editable: 0 },
      { player_stats: { 0: { coverage_type: 'date', date: '2026-01-14' }, stats: stats({ 9004003: '1/12', 9007006: '4/4', 10: '0', 12: '6', 15: '5', 16: '2', 17: '1', 18: '1', 19: '3' }) } },
    ] }, count: 1 } }, date: '2026-01-14' } },
  ] } })!
  assert.equal(day.team.mine, true)
  assert.equal(day.date, '2026-01-14')
  const p = day.players[0]
  assert.equal(p.slot, 'SG')
  assert.equal(p.team, 'CHA')
  assert.deepEqual(p.eligible, ['PG', 'SG', 'Util'])
  assert.equal(p.box!.fga, 12)
  assert.equal(p.box!.pts, 6)
})

test('game weeks and season settings parse; zero adds means no limit', () => {
  const weeks = parseGameWeeks({ fantasy_content: { game: [{ game_key: '466', code: 'nba' }, { game_weeks: {
    0: { game_week: { week: '1', start: '2025-10-21', end: '2025-10-26' } }, 1: { game_week: { week: '2', start: '2025-10-27', end: '2025-11-02' } }, count: 2 } }] } })
  assert.deepEqual(weeks, [[1, '2025-10-21', '2025-10-26'], [2, '2025-10-27', '2025-11-02']])
  const s = parseSeasonSettings({ fantasy_content: { league: [{ league_key: '466.l.1', scoring_type: 'head' }, { settings: [{
    max_adds: '100', max_weekly_adds: '10', trade_end_date: '2026-03-05', playoff_start_week: '19', num_playoff_teams: '6', waiver_type: 'R', uses_faab: '0' }] }] } })!
  assert.equal(s.maxAdds, 100)
  assert.equal(s.maxWeeklyAdds, 10)
  assert.equal(s.tradeEnd, '2026-03-05')
  const none = parseSeasonSettings({ fantasy_content: { league: [{}, { settings: [{ max_adds: '0', max_weekly_adds: '5', uses_faab: '1' }] }] } })!
  assert.equal(none.maxAdds, null)
  assert.equal(none.faab, true)
})

test('seating starts the most valuable players the seats can hold', () => {
  const seats = startingSeats({ PG: 1, SG: 1, SF: 1, PF: 1, C: 1, Util: 2, BN: 3, IL: 2 })
  assert.equal(seats.length, 7)
  // Three centres and two guards for seven seats: one centre in C, two in Util, both guards placed.
  const pos = [['C'], ['C'], ['C'], ['PG'], ['PG', 'SG'], ['C']]
  const worth = [5, 4, 3, 2, 1, 0.5]
  const placed = seat(pos, worth, seats)
  const who = new Set(placed.values())
  assert.equal(who.size, 5)
  assert.ok(!who.has(5), 'the fourth centre has nowhere to sit')
  // A two-position guard moves so a one-position guard is not left out.
  const g = seat([['PG', 'SG'], ['PG']], [2, 1], ['PG', 'SG'])
  assert.equal(new Set(g.values()).size, 2)
})

const line = (pts: number, extra: Partial<Box> = {}): Box => ({ ...emptyBox(), fgm: pts / 2.5, fga: pts / 1.15, ftm: 2, fta: 2.5, tpm: 1, pts, reb: 5, ast: 3, stl: 1, blk: 0.5, to: 2, ...extra })

test('a week counts only the days a player\'s team plays and the seats free that day', () => {
  const men: Man[] = [
    { id: 'a', name: 'A', positions: ['C'], team: 'DEN' },
    { id: 'b', name: 'B', positions: ['C'], team: 'BOS' },
  ]
  const games: Record<string, string[]> = { '2026-01-12': ['DEN', 'BOS'], '2026-01-13': ['DEN'], '2026-01-14': [] }
  const w = projectWeek({
    men, seats: ['C'], days: daysFrom('2026-01-12', '2026-01-18', '2026-01-12').slice(0, 3),
    playing: (d) => new Set(games[d] ?? []),
    outlook: (id) => ({ box: line(id === 'a' ? 25 : 15), play: 1 }),
    worth: (id) => (id === 'a' ? 2 : 1),
  })
  assert.equal(w.starts, 2)
  assert.equal(w.wasted, 1, 'both play Monday and there is one seat')
  assert.equal(w.perMan.get('b')!.starts, 0)
  assert.equal(w.box.pts, 50)
  assert.deepEqual(w.days[0].idle, ['b'])
})

test('a doubtful player adds his chance of playing, and the doubt shows in the spread', () => {
  const w = projectWeek({
    men: [{ id: 'a', name: 'A', positions: ['PG'], team: 'DEN' }], seats: ['PG'], days: ['d1'],
    playing: () => new Set(['DEN']), outlook: () => ({ box: line(20), play: 0.5 }), worth: () => 1,
  })
  assert.equal(w.box.pts, 10)
  assert.ok(w.variance.pts > 0.5 * 2.5 * 20, 'not playing at all is part of the spread')
})

const side = (now: Box, rest: Box, k = 1): SideOutlook => ({ now, rest, restVar: Object.fromEntries(Object.entries(rest).map(([s, v]) => [s, v * k])) as unknown as Box })

test('a race that is over is decided; one still open is a chance, and fewer turnovers win', () => {
  const done = race('pts', side(line(600), emptyBox()), side(line(500), emptyBox()))
  assert.equal(done.win, 1)
  assert.equal(done.state, 'done')
  const open = race('pts', side(line(500), line(100), 3), side(line(500), line(100), 3))
  assert.ok(open.win > 0.4 && open.win < 0.5 && open.tie > 0, `${open.win} ${open.tie}`)
  const to = race('to', side(line(500, { to: 40 }), emptyBox()), side(line(500, { to: 50 }), emptyBox()))
  assert.equal(to.win, 1)
})

test('the week is the count of races: five even races is a coin flip, nine sure ones a lock', () => {
  const even = weekOdds(Array(9).fill(0).map(() => ({ cat: 'pts' as const, mineNow: 0, theirsNow: 0, mine: 0, theirs: 0, win: 0.5, tie: 0, state: 'swing' as const })))
  assert.ok(Math.abs(even.win - 0.5) < 1e-9)
  assert.equal(even.expected, 4.5)
  const sure = weekOdds(Array(9).fill(0).map(() => ({ cat: 'pts' as const, mineNow: 0, theirsNow: 0, mine: 0, theirs: 0, win: 1, tie: 0, state: 'done' as const })))
  assert.equal(sure.win, 1)
  const cw = categoryWeek(side(line(600), line(100), 2), side(line(400), line(100), 2))
  assert.equal(cw.races.length, 9)
  assert.ok(cw.races.find((r) => r.cat === 'pts')!.win > 0.99)
})

test('a points week adds the rest to what is banked, scored the league\'s way', () => {
  const w = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 }
  const o = pointsWeek(side(emptyBox(), line(100), 2), side(emptyBox(), line(80), 2), w, { mine: 300, theirs: 310 })
  assert.equal(o.mineNow, 300)
  assert.ok(o.mine > o.theirs, 'twenty more points to come outweigh a ten-point deficit')
  assert.ok(o.win > 0.5 && o.win < 1)
})

test('box lines read from Yahoo stats ignore percentage strings and keep makes', () => {
  const b = boxOf(stats({ 9004003: '7/14', 5: '.500', 9007006: '3/4', 8: '.750', 12: '20' }))!
  assert.equal(b.fgm, 7)
  assert.equal(b.ftm, 3)
  assert.equal(b.pts, 20)
  assert.equal(boxOf([]), null)
})
