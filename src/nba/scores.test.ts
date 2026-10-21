import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEspnScoreboard, teamGame } from './scores.js'

/** ESPN's scoreboard, cut to the fields read, in the shapes seen on 2026-10-20 (final) and 2026-10-21 (before tip). */
const event = (state: string, detail: string, period: number, clock: string, home: [string, string], away: [string, string]) => ({
  status: { period, displayClock: clock, type: { state, shortDetail: detail } },
  competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: home[0] }, score: home[1] },
    { homeAway: 'away', team: { abbreviation: away[0] }, score: away[1] },
  ] }],
})

test("ESPN's scoreboard read into tonight's games, its team codes made the app's", () => {
  const games = parseEspnScoreboard({ events: [
    event('post', 'Final', 4, '12:00', ['NY', '100'], ['PHI', '106']),
    event('in', '4:12 - 2nd', 2, '4:12', ['GS', '55'], ['UTAH', '48']),
    event('in', 'Halftime', 2, '0.0', ['WSH', '60'], ['MIL', '61']),
    event('in', 'End of 3rd', 3, '0.0', ['SA', '80'], ['NO', '77']),
    event('pre', '10/21 - 7:00 PM EDT', 0, '0.0', ['ORL', '0'], ['ATL', '0']),
  ] })
  assert.deepEqual(games.map((g) => `${g.away}@${g.home}`), ['PHI@NYK', 'UTA@GSW', 'MIL@WAS', 'NOP@SAS', 'ATL@ORL'])
  const phi = teamGame(games, 'PHI')!
  assert.deepEqual([phi.us, phi.them, phi.status, phi.won, phi.played], [106, 100, 'Final', true, 1], 'his team first; won')
  assert.equal(teamGame(games, 'NYK')!.won, false)
  const gsw = teamGame(games, 'GSW')!
  assert.equal(gsw.status, 'Q2 4:12')
  assert.ok(Math.abs(gsw.played! - (12 + 12 - 4.2) / 48) < 1e-9, 'a quarter and 7.8 minutes of 48')
  assert.equal(teamGame(games, 'WAS')!.status, 'Half')
  assert.equal(teamGame(games, 'SAS')!.status, 'End Q3')
  assert.equal(teamGame(games, 'SAS')!.played, 0.75)
  assert.deepEqual([teamGame(games, 'ORL')!.state, teamGame(games, 'ORL')!.played], ['pre', 0])
  assert.equal(teamGame(games, 'BOS'), null, 'no game tonight')
  assert.deepEqual(parseEspnScoreboard({}), [])
})
