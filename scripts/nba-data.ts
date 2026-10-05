/**
 * Builds the basketball tables the value models will read:
 *
 *   data/nba/players.json   every projected or Yahoo-ranked player, joined
 *   data/nba/teams.json     pace, ratings, games per fantasy week, playoff games
 *   data/nba/schedule.json  every game, by Eastern date
 *
 * Sources: Sleeper (players, projections, three seasons of history),
 * FantasyPros (projections with games played), ESPN (the schedule only — its
 * rankings and projections are deliberately not used), Basketball-Reference
 * (last season's pace and ratings), and the Yahoo snapshot in
 * data/nba/yahoo-ranks.json, which a local run cannot refresh because the Yahoo
 * token lives only on Railway.
 *
 * `--offline` rebuilds from data/nba/raw without fetching.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  parseBrefAdvanced, parseCbsInjuries, parseEspnSchedule, parseFantasyPros, parseSleeperProjections, parseSleeperSeason, parseYahooRanks,
} from '../src/nba/sources.js'
import { NameIndex, consensus, durability, teamRows } from '../src/nba/join.js'
import type { NbaPlayer, Season, SourceLine, TeamNote, YahooWeek } from '../src/nba/types.js'

const SEASON = 2026
/** History runs to the last finished season. */
const LAST = SEASON - 1
const HISTORY = [LAST - 2, LAST - 1, LAST]
const DIR = 'data/nba'
const RAW = `${DIR}/raw`
const OFFLINE = process.argv.includes('--offline')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36'

async function source(file: string, url: string): Promise<string> {
  const path = `${RAW}/${file}`
  if (OFFLINE) {
    if (!existsSync(path)) throw new Error(`--offline but ${path} is missing`)
    return readFile(path, 'utf8')
  }
  const res = await fetch(url, { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const body = await res.text()
  await writeFile(path, body)
  return body
}

async function main() {
  await mkdir(RAW, { recursive: true })

  const [playersRaw, projRaw, fprosRaw, schedRaw, brefRaw, cbsRaw, ...seasonRaw] = await Promise.all([
    source('sleeper-players.json', 'https://api.sleeper.app/v1/players/nba'),
    source('sleeper-projections.json', `https://api.sleeper.app/projections/nba/${SEASON}?season_type=regular`),
    source('fantasypros.html', 'https://www.fantasypros.com/nba/projections/overall.php'),
    source('espn-schedule.json', `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON + 1}?view=proTeamSchedules_wl`),
    source('bref.html', `https://www.basketball-reference.com/leagues/NBA_${SEASON}.html`),
    source('cbs-injuries.html', 'https://www.cbssports.com/nba/injuries/'),
    ...HISTORY.map((y) => source(`sleeper-stats-${y}.json`, `https://api.sleeper.app/stats/nba/${y}?season_type=regular`)),
  ])

  const sleeper: Record<string, any> = JSON.parse(playersRaw)
  const sleeperLines = parseSleeperProjections(JSON.parse(projRaw))
  const seasons = HISTORY.map((y, i) => parseSleeperSeason(JSON.parse(seasonRaw[i]), y))
  const fpros = parseFantasyPros(fprosRaw)
  const games = parseEspnSchedule(JSON.parse(schedRaw))
  const bref = parseBrefAdvanced(brefRaw)

  const yahooFile = JSON.parse(await readFile(`${DIR}/yahoo-ranks.json`, 'utf8'))
  const yahoo = parseYahooRanks(yahooFile.ranks)
  const weeks: YahooWeek[] = yahooFile.weeks
  const leagues = JSON.parse(await readFile(`${DIR}/leagues.json`, 'utf8')).leagues as { id: string; playoffWeeks: number[] }[]
  const notes: Record<string, TeamNote[]> = JSON.parse(await readFile(`${DIR}/team-notes.json`, 'utf8')).teams

  // Anyone on a roster, plus anyone a source projects (a free agent can still be projected).
  const pool = Object.values(sleeper).filter((p: any) => p.team || sleeperLines.has(p.player_id))
  const index = new NameIndex(pool.map((p: any) => ({ id: p.player_id, name: p.full_name ?? `${p.first_name} ${p.last_name}`, team: p.team ?? null })))

  const fprosById = new Map<string, SourceLine>()
  const unmatchedFpros: string[] = []
  for (const r of fpros) {
    const id = index.resolve(r.name, r.team)
    if (id) fprosById.set(id, r.line)
    else unmatchedFpros.push(`${r.name} (${r.team})`)
  }

  const yahooById = new Map<string, (typeof yahoo)[number]>()
  const unmatchedYahoo: string[] = []
  for (const r of yahoo) {
    const id = index.resolve(r.name, r.team)
    if (id) yahooById.set(id, r)
    else unmatchedYahoo.push(`${r.rank}. ${r.name} (${r.team})`)
  }

  // Players who will not play again, whatever the feeds still list (data/nba/excluded.json).
  const excluded = new Set((JSON.parse(await readFile(`${DIR}/excluded.json`, 'utf8')).players as { name: string }[])
    .map((x) => index.resolve(x.name, null)).filter((id): id is string => !!id))
  const ids = new Set([...sleeperLines.keys(), ...fprosById.keys(), ...yahooById.keys()].filter((id) => !excluded.has(id)))
  const players: NbaPlayer[] = []
  for (const id of ids) {
    const p = sleeper[id]
    if (!p) continue
    const history: Season[] = seasons.map((m) => m.get(id)).filter((s): s is Season => !!s)
    const yearsExp = typeof p.years_exp === 'number' ? p.years_exp : null
    const dur = durability(history, yearsExp, LAST)
    const lines: NbaPlayer['lines'] = {}
    if (sleeperLines.has(id)) lines.sleeper = sleeperLines.get(id)
    if (fprosById.has(id)) lines.fantasypros = fprosById.get(id)
    const y = yahooById.get(id)
    players.push({
      id,
      name: p.full_name ?? `${p.first_name} ${p.last_name}`,
      team: p.team ?? null,
      positions: p.fantasy_positions ?? (p.position ? [p.position] : []),
      age: typeof p.age === 'number' ? p.age : null,
      yearsExp,
      injury: p.injury_status ? { status: p.injury_status, body: p.injury_body_part ?? null, notes: p.injury_notes ?? null } : null,
      yahoo: y ? { yahooId: y.yahooId, rank: y.rank, adp: y.adp, cost: y.cost, pctDrafted: y.pctDrafted, positions: y.positions, status: y.status } : null,
      lines,
      projection: consensus(Object.values(lines), dur),
      history,
      durability: dur,
    })
  }
  // Yahoo's order first, since that is the board opponents see; then by projected minutes.
  players.sort((a, b) =>
    (a.yahoo?.rank ?? 1e9) - (b.yahoo?.rank ?? 1e9) ||
    (b.projection?.perGame.min ?? 0) - (a.projection?.perGame.min ?? 0))

  const teams = teamRows(games, weeks, leagues, bref, notes)

  const round = (_: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v)
  await writeFile(`${DIR}/players.json`, JSON.stringify({ built: new Date().toISOString(), season: SEASON, players }, round, 1))
  await writeFile(`${DIR}/teams.json`, JSON.stringify({ built: new Date().toISOString(), teams }, round, 1))
  await writeFile(`${DIR}/schedule.json`, JSON.stringify({ built: new Date().toISOString(), games }))
  // A snapshot of who starts hurt and when they are back; the server re-reads CBS itself.
  const injuries = parseCbsInjuries(cbsRaw, SEASON)
  await writeFile(`${DIR}/injuries.json`, JSON.stringify({ built: new Date().toISOString(), source: 'https://www.cbssports.com/nba/injuries/', injuries }, null, 1))
  console.log(`injuries ${injuries.length}; with a return date ${injuries.filter((i) => i.returnDate).length}; out for the season ${injuries.filter((i) => i.outForSeason).length}`)

  // The report is the point of a data layer: what joined, what did not, and what looks wrong.
  const projected = players.filter((p) => p.projection)
  const gpSources = projected.reduce<Record<string, number>>((m, p) => ((m[p.projection!.gpSource] = (m[p.projection!.gpSource] ?? 0) + 1), m), {})
  const top = players.filter((p) => p.yahoo && p.yahoo.rank <= 200)
  console.log(`players ${players.length} (projected ${projected.length}); sleeper lines ${sleeperLines.size}, fantasypros ${fpros.length} → matched ${fprosById.size}, yahoo ${yahoo.length} → matched ${yahooById.size}`)
  console.log(`games-played source: ${JSON.stringify(gpSources)}`)
  console.log(`Yahoo top 200: ${top.filter((p) => p.lines.sleeper).length} have Sleeper, ${top.filter((p) => p.lines.fantasypros).length} have FantasyPros, ${top.filter((p) => !p.projection).length} have no projection`)
  console.log(`games ${games.length}; per team ${Math.min(...teams.map((t) => t.games))}–${Math.max(...teams.map((t) => t.games))}; teams ${teams.length}; bref teams ${bref.length}`)
  if (unmatchedYahoo.length) console.log(`unmatched Yahoo (${unmatchedYahoo.length}): ${unmatchedYahoo.join('; ')}`)
  if (unmatchedFpros.length) console.log(`unmatched FantasyPros (${unmatchedFpros.length}): ${unmatchedFpros.join('; ')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
