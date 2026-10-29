import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  easternDate, gameDay, parseBrefAdvanced, parseEspnSchedule, parseFantasyPros, parseSleeperProjections, parseSleeperSeason,
} from './sources.js'
import { DEFAULT_GP, NameIndex, consensus, durability, teamRows } from './join.js'
import type { Season, SourceLine } from './types.js'

const line = (source: SourceLine['source'], pts: number, gp: number | null, fgPct: number | null = 0.5, fga: number | null = 10): SourceLine => ({
  source,
  perGame: { min: 30, pts, reb: 5, ast: 5, stl: 1, blk: 1, tpm: 2, to: 2 },
  shooting: { fgPct, ftPct: 0.8, fga, fta: 4 },
  gp,
})

test('a late tip is played on the Eastern date, not the UTC one', () => {
  // 10:30pm Eastern on 20 October is 02:30 on the 21st in UTC.
  assert.equal(easternDate(Date.UTC(2026, 9, 21, 2, 30)), '2026-10-20')
})

test("a night's games own the day until 4am Eastern, so a late game still on at midnight is today's", () => {
  // 00:05 Eastern on Friday 23 October (04:05 UTC): Denver at OKC, a 9:30pm tip, is still on.
  assert.equal(gameDay(Date.UTC(2026, 9, 23, 4, 5)), '2026-10-22')
  // 3:59am Eastern is still Thursday's night; 4:00am is Friday.
  assert.equal(gameDay(Date.UTC(2026, 9, 23, 7, 59)), '2026-10-22')
  assert.equal(gameDay(Date.UTC(2026, 9, 23, 8, 0)), '2026-10-23')
  // A noon Eastern game is on its own date.
  assert.equal(gameDay(Date.UTC(2026, 11, 25, 17, 0)), '2026-12-25')
})

test('the schedule lists each game once although ESPN lists it under both teams', () => {
  const game = { id: 1, date: Date.UTC(2026, 9, 21, 0, 0), homeProTeamId: 24, awayProTeamId: 3 }
  const games = parseEspnSchedule({
    settings: {
      proTeams: [
        { id: 24, abbrev: 'SA', proGamesByScoringPeriod: { 1: [game] } },
        { id: 3, abbrev: 'NO', proGamesByScoringPeriod: { 1: [game] } },
        { id: 0, abbrev: 'FA' },
      ],
    },
  })
  // Midnight UTC is the evening before in the East: the game is on the 20th, tipping at 8pm Eastern.
  assert.deepEqual(games, [{ id: '1', date: '2026-10-20', tip: '2026-10-21T00:00:00.000Z', home: 'SAS', away: 'NOP' }])
})

test('Sleeper projections are per game and keep attempts for weighting the percentages', () => {
  const m = parseSleeperProjections([
    { player_id: '7', stats: { gp: 1, sp: 1800, pts: 20, fgm: 8, fga: 16, ftm: 3, fta: 4, reb: 5, ast: 4, stl: 1, blk: 0.5, tpm: 2, to: 2 } },
    { player_id: '8', stats: { gp: 1, sp: 0, pts: 0 } },
  ])
  const l = m.get('7')!
  assert.equal(l.perGame.min, 30)
  assert.equal(l.shooting.fgPct, 0.5)
  assert.equal(l.shooting.fga, 16)
  assert.equal(l.gp, null, 'Sleeper does not project games played')
  assert.equal(m.has('8'), false, 'a player projected for no minutes is not a projection')
})

test('a season line is totals divided by games', () => {
  const s = parseSleeperSeason([{ player_id: '7', team: 'BOS', stats: { gp: 50, gs: 50, sp: 50 * 1800, pts: 1000, fga: 800, fgm: 400 } }], 2025)
  assert.equal(s.get('7')!.perGame.pts, 20)
  assert.equal(s.get('7')!.shooting.fga, 16)
  assert.equal(s.get('7')!.season, 2025)
})

test('FantasyPros columns are read from the header and team codes are mapped', () => {
  const html = `<table><thead><tr><th>Player</th><th>PTS</th><th>REB</th><th>AST</th><th>BLK</th><th>STL</th><th>FG%</th><th>FT%</th><th>3PM</th><th>GP</th><th>MIN</th><th>TO</th></tr></thead>
  <tr class="mpb-player-1"><td><a fp-player-name="Zion Williamson">Zion Williamson</a> <small>(NOR - PF,C)</small></td>
  <td class="center">1,000</td><td class="center">400</td><td class="center">250</td><td class="center">30</td><td class="center">50</td>
  <td class="center">.580</td><td class="center">.700</td><td class="center">10</td><td class="center">50</td><td class="center">1,500</td><td class="center">150</td></tr></table>`
  const [r] = parseFantasyPros(html)
  assert.equal(r.team, 'NOP')
  assert.deepEqual(r.positions, ['PF', 'C'])
  assert.equal(r.line.gp, 50)
  assert.equal(r.line.perGame.pts, 20)
  assert.equal(r.line.perGame.min, 30)
  assert.equal(r.line.shooting.fgPct, 0.58)
})

test('a FantasyPros table that has lost a column fails loudly', () => {
  assert.throws(() => parseFantasyPros('<thead><tr><th>Player</th><th>PTS</th></tr></thead>'), /no REB column/)
})

test('Basketball-Reference team codes are mapped onto Sleeper\'s', () => {
  const html = `<table id="advanced-team"><tr><td data-stat="team"><a href='/teams/BRK/2026.html'>Brooklyn Nets</a></td>
  <td data-stat="off_rtg">110.1</td><td data-stat="def_rtg">117.0</td><td data-stat="pace">99.4</td></tr></table>`
  assert.deepEqual(parseBrefAdvanced(html), [{ team: 'BKN', pace: 99.4, offRtg: 110.1, defRtg: 117 }])
})

test('names join across accents and suffixes, and a shared name needs the team', () => {
  const idx = new NameIndex([
    { id: '1', name: 'Nikola Jokic', team: 'DEN' },
    { id: '2', name: 'Jimmy Butler', team: 'GSW' },
    { id: '3', name: 'Tre Jones', team: 'CHI' },
    { id: '4', name: 'Tyus Jones', team: 'DEN' },
  ])
  assert.equal(idx.resolve('Nikola Jokić', 'DEN'), '1')
  assert.equal(idx.resolve('Jimmy Butler III', 'GSW'), '2')
  assert.equal(idx.resolve('Nikola Jokić', 'LAL'), '1', 'a traded player still resolves on a unique name')
  assert.equal(idx.resolve('T. Jones', null), null, 'an initial alone is ambiguous without a team')
  assert.equal(idx.resolve('T. Jones', 'CHI'), '3')
})

test('a season lost to injury counts against durability; a rookie has none', () => {
  const s = (season: number, gp: number) => ({ season, gp } as Season)
  // In the league three seasons, missed the last entirely after two healthy ones: a one-off, at half weight.
  const hurt = durability([s(2023, 82), s(2024, 82)], 5, 2025)
  assert.equal(hurt.seasons, 3)
  assert.equal(hurt.gpShare, (0 * 1.5 + 1 * 2 + 1 * 1) / 4.5)
  // Two lost seasons is a pattern: full weight.
  const chronic = durability([s(2023, 82), s(2024, 15), s(2025, 20)], 5, 2025)
  assert.equal(chronic.gpShare, ((20 / 82) * 3 + (15 / 82) * 2 + 1 * 1) / 6)
  // A lost season beside thin ones is a pattern too.
  const thin = durability([s(2023, 40), s(2024, 40), s(2025, 10)], 5, 2025)
  assert.equal(thin.gpShare, ((10 / 82) * 3 + (40 / 82) * 2 + (40 / 82) * 1) / 6)
  // A second-year player is measured over his one season only.
  assert.deepEqual(durability([s(2025, 41)], 1, 2025), { seasons: 1, gpShare: 0.5 })
  assert.deepEqual(durability([], 0, 2025), { seasons: 0, gpShare: null })
})

test('games played come from a projection, then history, then a default', () => {
  const dur = { seasons: 3, gpShare: 0.5 }
  assert.equal(consensus([line('sleeper', 20, null), line('fantasypros', 22, 70)], dur)!.gpSource, 'fantasypros')
  const hist = consensus([line('sleeper', 20, null)], dur)!
  assert.equal(hist.gpSource, 'history')
  assert.equal(hist.gp, 41)
  assert.equal(consensus([line('sleeper', 20, null)], { seasons: 0, gpShare: null })!.gp, DEFAULT_GP)
})

test('the consensus is a plain mean, and attempts come from whoever projects them', () => {
  const c = consensus([line('sleeper', 20, null, 0.5, 16), line('fantasypros', 24, 70, 0.6, null)], { seasons: 0, gpShare: null })!
  assert.equal(c.perGame.pts, 22)
  assert.equal(c.shooting.fgPct, 0.55)
  assert.equal(c.shooting.fga, 16)
  assert.deepEqual(c.sources, ['sleeper', 'fantasypros'])
})

test('team rows count games by fantasy week, back-to-backs and each league\'s playoff games', () => {
  const games = [
    { id: 'a', date: '2027-03-15', home: 'DAL', away: 'PHX' },
    { id: 'b', date: '2027-03-16', home: 'PHX', away: 'DAL' },
    { id: 'c', date: '2027-03-29', home: 'DAL', away: 'SAS' },
  ]
  const weeks: [number, string, string][] = [[20, '2027-03-15', '2027-03-21'], [21, '2027-03-22', '2027-03-28'], [22, '2027-03-29', '2027-04-04']]
  const rows = teamRows(games, weeks, [{ id: 'pts', playoffWeeks: [20, 21, 22] }, { id: 'cats', playoffWeeks: [21] }], [], {})
  const dal = rows.find((r) => r.team === 'DAL')!
  assert.equal(dal.games, 3)
  assert.equal(dal.backToBacks, 1)
  assert.deepEqual(dal.byWeek, { 20: 2, 22: 1 })
  assert.deepEqual(dal.playoffGames, { pts: 3, cats: 0 })
})

test('real minutes are trusted after a few games, what he does per minute only slowly; a game cut short is left out', async () => {
  const { withForm, MIN_FORM_GAMES, FORM_GAMES } = await import('./outlook.js')
  const dunn = { id: 'kd', name: 'Kris Dunn', team: 'LAC', positions: ['PG', 'SG'], projection: { gp: 70, perGame: { min: 22, pts: 5.9, reb: 2.9, ast: 2.9, stl: 1.4, blk: 0.3, tpm: 0.9, to: 1.0 }, shooting: { fgPct: 0.464, fga: 5, ftPct: 0.744, fta: 0.7 } } } as any
  const box = (pts: number, stl: number) => ({ fgm: 3, fga: 6, ftm: 1, fta: 1, tpm: 1, pts, reb: 5, ast: 6, stl, blk: 1, to: 2 })
  // Week 1 as he played it: 27, 34 and 33 minutes, ten steals.
  const logs = [{ id: 'kd', date: '2026-10-21', team: 'LAC', min: 27, box: box(7, 3) }, { id: 'kd', date: '2026-10-23', team: 'LAC', min: 34, box: box(7, 2) }, { id: 'kd', date: '2026-10-25', team: 'LAC', min: 33, box: box(15, 5) }]
  const f = withForm(dunn, logs)
  const real = (27 + 34 + 33) / 3
  assert.ok(Math.abs(f.projection!.perGame.min - (22 + (real - 22) * 3 / (3 + MIN_FORM_GAMES))) < 1e-9, `minutes ${f.projection!.perGame.min}`)
  assert.ok(f.projection!.perGame.min > 26, 'three games of a bigger role move him most of the way')
  // Steals per minute blended slowly, then times his new minutes: more steals than either the old line or his rate alone.
  const w = 3 / (3 + FORM_GAMES), perMin = (1.4 / 22) * (1 - w) + (10 / 94) * w
  assert.ok(Math.abs(f.projection!.perGame.stl - perMin * f.projection!.perGame.min) < 1e-9)
  assert.ok(f.projection!.perGame.stl > 1.8, `steals ${f.projection!.perGame.stl}`)
  // A game he left hurt (11 of a projected 32 minutes) does not pull his minutes down.
  const cam = { ...dunn, id: 'cj', projection: { ...dunn.projection, perGame: { ...dunn.projection.perGame, min: 32 } } }
  const hurt = withForm(cam, [{ id: 'cj', date: '2026-10-22', team: 'DEN', min: 11, box: box(5, 0) }])
  assert.equal(hurt.projection!.perGame.min, 32)
  // Short games that are most of his games are his role (Filipowski, projected 21.5, played 9, 8 and 8): they count.
  const fil = { ...dunn, id: 'kf', projection: { ...dunn.projection, perGame: { ...dunn.projection.perGame, min: 21.5 } } }
  const role = withForm(fil, ['2026-10-22', '2026-10-24', '2026-10-26'].map((date, i) => ({ id: 'kf', date, team: 'UTA', min: [9, 8, 8][i], box: box(3, 0) })))
  assert.ok(Math.abs(role.projection!.perGame.min - (21.5 + (25 / 3 - 21.5) * 3 / (3 + MIN_FORM_GAMES))) < 1e-9, `minutes ${role.projection!.perGame.min}`)
  // Two short games among five are still games cut short.
  const mixed = withForm(fil, [22, 6, 22, 7, 22].map((min, i) => ({ id: 'kf', date: `2026-10-2${i}`, team: 'UTA', min, box: box(8, 1) })))
  assert.ok(Math.abs(mixed.projection!.perGame.min - (21.5 + (22 - 21.5) * 3 / (3 + MIN_FORM_GAMES))) < 1e-9, `minutes ${mixed.projection!.perGame.min}`)
})
