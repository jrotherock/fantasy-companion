/**
 * Runs both basketball value models over data/nba/players.json and writes
 * data/nba/values.json: Harker on points, Hoops on categories under a set of
 * named builds.
 *
 * `--actual 2025` values a finished season's real lines instead of the
 * projections, with real games played — the check that the engine ranks a
 * season everyone has already seen the way it should.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { categoryZ, pointsValues, rankBuild, type Cat } from '../src/nba/value.js'
import type { NbaPlayer } from '../src/nba/types.js'

const DIR = 'data/nba'
const actualAt = process.argv.indexOf('--actual')
const ACTUAL = actualAt > 0 ? Number(process.argv[actualAt + 1]) : null

/** The builds worth ranking for. Pairs are the ones the punt literature and last season's own team suggest. */
export const BUILDS: { name: string; punt: Cat[] }[] = [
  { name: 'balanced', punt: [] },
  { name: 'punt FT%', punt: ['ft'] },
  { name: 'punt FG%', punt: ['fg'] },
  { name: 'punt AST', punt: ['ast'] },
  { name: 'punt TO', punt: ['to'] },
  { name: 'punt 3PM', punt: ['tpm'] },
  { name: 'punt PTS', punt: ['pts'] },
  { name: 'punt AST+TO', punt: ['ast', 'to'] },
  { name: 'punt FT%+3PM', punt: ['ft', 'tpm'] },
  { name: 'punt REB+BLK', punt: ['reb', 'blk'] },
  { name: 'punt FG%+TO', punt: ['fg', 'to'] },
]

/** A finished season's line, shaped like a projection, with the games actually played. */
function asActual(p: NbaPlayer, season: number): NbaPlayer | null {
  const s = p.history.find((h) => h.season === season)
  if (!s) return null
  return {
    ...p,
    projection: { perGame: s.perGame, shooting: s.shooting, gp: s.gp, gpSource: 'history', sources: [] },
    durability: { seasons: 1, gpShare: s.gp / 82 },
  }
}

async function main() {
  const built = JSON.parse(await readFile(`${DIR}/players.json`, 'utf8'))
  const leagues = JSON.parse(await readFile(`${DIR}/leagues.json`, 'utf8')).leagues
  const harker = leagues.find((l: any) => l.id === 'nba-harker')
  const hoops = leagues.find((l: any) => l.id === 'nba-hoops')
  let players: NbaPlayer[] = built.players
  if (ACTUAL) players = players.map((p) => asActual(p, ACTUAL)).filter((p): p is NbaPlayer => !!p)

  const points = pointsValues(players, harker)
  const z = categoryZ(players, hoops)
  const builds = BUILDS.map((b) => ({ ...b, ranked: rankBuild(z, hoops, b.punt) }))

  const fmt = (n: number, d = 1) => n.toFixed(d)
  const yr = (r: number | null) => (r == null ? '  —' : String(r).padStart(3))
  const label = ACTUAL ? `${ACTUAL}-${String(ACTUAL + 1).slice(2)} actual` : 'projected'

  console.log(`\nHARKER (points, ${harker.teams} teams) — ${label}. Replacement line ${fmt(points.replacementFpg)} fp/game`)
  console.log('  rank  yahoo  fp/g   games  value  player')
  for (const r of points.rows.slice(0, 30))
    console.log(`  ${String(r.rank).padStart(4)}  ${yr(r.yahooRank)}  ${fmt(r.fpg).padStart(5)}  ${fmt(r.games.gp, 0).padStart(5)}  ${fmt(r.value, 0).padStart(5)}  ${r.name} (${r.team})`)

  // Yahoo's ranks are this season's, so against a finished season they compare nothing.
  const gap = ACTUAL ? [] : points.rows.filter((r) => r.rank <= 120 && r.yahooRank != null)
    .map((r) => ({ r, d: r.yahooRank! - r.rank }))
  if (gap.length) console.log('  Yahoo ranks lowest against this scoring (top 120 here):')
  for (const { r, d } of [...gap].sort((a, b) => b.d - a.d).slice(0, 12)) console.log(`    ${r.name.padEnd(24)} here ${r.rank}, Yahoo ${r.yahooRank} (+${d})`)
  if (gap.length) console.log('  Yahoo ranks highest against this scoring:')
  for (const { r, d } of [...gap].sort((a, b) => a.d - b.d).slice(0, 8)) console.log(`    ${r.name.padEnd(24)} here ${r.rank}, Yahoo ${r.yahooRank} (${d})`)

  console.log(`\nHOOPS (9-cat, ${hoops.teams} teams) — ${label}`)
  const balanced = builds[0].ranked
  console.log('  balanced: rank  yahoo  z/game  games  player')
  for (const r of balanced.slice(0, 30))
    console.log(`  ${String(r.rank).padStart(14)}  ${yr(r.yahooRank)}  ${fmt(r.perGame, 2).padStart(6)}  ${fmt(r.gp, 0).padStart(5)}  ${r.name} (${r.team})`)
  for (const b of builds.slice(1)) {
    const risers = b.ranked.filter((r) => r.rank <= 60)
      .map((r) => ({ r, up: (balanced.find((x) => x.id === r.id)?.rank ?? 999) - r.rank }))
      .sort((a, c) => c.up - a.up).slice(0, 6)
    console.log(`  ${b.name.padEnd(14)} top 5: ${b.ranked.slice(0, 5).map((r) => r.name).join(', ')}`)
    console.log(`  ${''.padEnd(14)} climbs most: ${risers.map(({ r, up }) => `${r.name} ${r.rank} (+${up})`).join(', ')}`)
  }

  if (!ACTUAL) {
    await writeFile(`${DIR}/values.json`, JSON.stringify({
      built: new Date().toISOString(),
      harker: { replacementFpg: points.replacementFpg, rows: points.rows },
      hoops: { z, builds: builds.map((b) => ({ name: b.name, punt: b.punt, ranked: b.ranked })) },
    }, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v)))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
