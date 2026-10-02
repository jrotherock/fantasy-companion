/**
 * The basketball draft recommender from the command line, until it has a
 * screen.
 *
 *   npm run draft:nba -- --league hoops --slot 9 --taken "Nikola Jokic;Victor Wembanyama;..."
 *       advice for the pick after everything listed (all teams, in draft order)
 *
 *   npm run draft:nba -- --league hoops --simulate
 *       a mock from every slot: the room drafts down Yahoo's ADP, and I draft
 *       by the recommender, by straight value, and by Yahoo's ADP, so the
 *       three can be compared on the same board
 */
import { readFile } from 'node:fs/promises'
import { categoryZ, pointsValues, rankBuild, rosterSpots, CATS, type Cat, type CatRow } from '../src/nba/value.js'
import {
  adpFor, adviseCategories, advisePoints, baseline, contribution, expectedCats, winChances, zero, type Strength,
} from '../src/nba/draft.js'
import { NameIndex } from '../src/nba/join.js'
import { overallFor, slotFor } from '../src/kernel/snake.js'
import type { NbaPlayer } from '../src/nba/types.js'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const which = arg('league') ?? 'hoops'
const SIMULATE = process.argv.includes('--simulate')

async function main() {
  const players: NbaPlayer[] = JSON.parse(await readFile('data/nba/players.json', 'utf8')).players
  const leagues = JSON.parse(await readFile('data/nba/leagues.json', 'utf8')).leagues
  const league = leagues.find((l: any) => l.id === `nba-${which}`)
  if (!league) throw new Error(`no league nba-${which}`)
  // IL slots are not drafted into.
  const rounds = rosterSpots(league.roster)
  const byId = new Map(players.map((p) => [p.id, p]))
  const adp = (id: string) => adpFor(byId.get(id)!)
  const index = new NameIndex(players.map((p) => ({ id: p.id, name: p.name, team: p.team })))

  const isCats = league.scoring === 'categories'
  const noise = JSON.parse(await readFile('data/nba/category-noise.json', 'utf8')).r as Record<Cat, number>
  const zRows = isCats ? categoryZ(players, league).map((r) => ({ ...r, adp: adp(r.id) })) : []
  const base = isCats ? baseline(zRows, league.teams, rounds, noise) : null
  const pts = !isCats ? pointsValues(players, league).rows.map((r) => ({ ...r, adp: adp(r.id) })) : []
  const rowOf = new Map<string, any>([...zRows, ...pts].map((r) => [r.id, r]))

  const advise = (taken: Set<string>, mine: string[], slot: number, overall: number) => {
    const spot = { teams: league.teams, rounds, slot, overall }
    if (isCats) return adviseCategories(zRows.filter((r) => !taken.has(r.id)), mine.map((id) => rowOf.get(id)), spot, base!)
    return advisePoints(pts.filter((r) => !taken.has(r.id)), spot)
  }

  const profile = (mine: string[]) => {
    const s = mine.reduce<Strength>((acc, id) => {
      const c = contribution(rowOf.get(id) as CatRow)
      return Object.fromEntries(CATS.map((k) => [k, acc[k] + c[k]])) as Strength
    }, zero())
    return { s, w: winChances(s, mine.length, base!), e: expectedCats(s, mine.length, base!) }
  }

  if (SIMULATE) {
    const balanced = isCats ? rankBuild(zRows, league, []) : null
    const valueOrder = isCats ? balanced!.map((r) => r.id) : [...pts].sort((a, b) => b.value - a.value).map((r) => r.id)
    const adpOrder = [...(isCats ? zRows : pts)].sort((a, b) => a.adp - b.adp).map((r) => r.id)
    const strategies: Record<string, (taken: Set<string>, mine: string[], slot: number, overall: number) => string> = {
      recommender: (t, m, s, o) => advise(t, m, s, o)[0].id,
      'best value': (t) => valueOrder.find((id) => !t.has(id))!,
      'Yahoo ADP': (t) => adpOrder.find((id) => !t.has(id))!,
    }
    const score = (mine: string[]) => isCats ? profile(mine).e : mine.reduce((n, id) => n + (rowOf.get(id)?.value ?? 0), 0)
    console.log(`${league.label}: mock drafts from every slot, the room drafting down Yahoo ADP. Score = ${isCats ? 'expected categories won a week against an average team (of 9)' : 'season value over replacement'}`)
    const totals: Record<string, number> = {}
    for (let slot = 1; slot <= league.teams; slot++) {
      const line: string[] = []
      for (const [name, pick] of Object.entries(strategies)) {
        const taken = new Set<string>(), mine: string[] = []
        for (let overall = 1; overall <= league.teams * rounds; overall++) {
          const id = slotFor(overall, league.teams) === slot ? pick(taken, mine, slot, overall) : adpOrder.find((x) => !taken.has(x))!
          taken.add(id)
          if (slotFor(overall, league.teams) === slot) mine.push(id)
        }
        const v = score(mine)
        totals[name] = (totals[name] ?? 0) + v
        line.push(`${name} ${v.toFixed(isCats ? 2 : 0)}`)
        if (name === 'recommender' && (slot === 1 || slot === 9 || slot === league.teams)) {
          const names = mine.map((id) => byId.get(id)!.name).join(', ')
          const w = isCats ? '  wins: ' + CATS.map((c) => `${c} ${(profile(mine).w[c] * 100).toFixed(0)}%`).join(' ') : ''
          console.log(`  slot ${slot} recommender roster: ${names}${w}`)
        }
      }
      console.log(`slot ${String(slot).padStart(2)}: ${line.join(' | ')}`)
    }
    console.log(`mean: ${Object.entries(totals).map(([k, v]) => `${k} ${(v / league.teams).toFixed(isCats ? 2 : 0)}`).join(' | ')}`)
    return
  }

  const slot = Number(arg('slot'))
  if (!slot) throw new Error('--slot is required')
  const takenNames = (arg('taken') ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  const taken = new Set<string>(), mine: string[] = []
  takenNames.forEach((n, i) => {
    const id = index.resolve(n, null)
    if (!id) throw new Error(`cannot place "${n}" — check the spelling`)
    taken.add(id)
    if (slotFor(i + 1, league.teams) === slot) mine.push(id)
  })
  const overall = taken.size + 1
  const mineNow = slotFor(overall, league.teams) === slot
  const myNext = Array.from({ length: rounds }, (_, r) => overallFor(r + 1, slot, league.teams)).find((o) => o >= overall)
  console.log(`${league.label}, slot ${slot}: pick ${overall}${mineNow ? ' is yours' : ` — yours is ${myNext}`}. Roster: ${mine.map((id) => byId.get(id)!.name).join(', ') || 'none yet'}`)
  if (isCats && mine.length) {
    const p = profile(mine)
    console.log(`  this week vs an average team: ${CATS.map((c) => `${c} ${(p.w[c] * 100).toFixed(0)}%`).join('  ')}  → ${p.e.toFixed(2)} of 9`)
    const punting = CATS.filter((c) => p.w[c] < 0.35)
    if (punting.length) console.log(`  already punting: ${punting.join(', ')}`)
  }
  const advice = advise(taken, mine, slot, mineNow ? overall : myNext!)
  console.log(`  ${'player'.padEnd(26)} ${isCats ? 'vs avg pick' : 'value'}   with next pick   there next time`)
  for (const a of advice.slice(0, 12)) {
    const tag = a.survives >= 0.6 ? '  can wait' : ''
    console.log(`  ${a.name.padEnd(26)} ${a.now.toFixed(isCats ? 3 : 0).padStart(8)}   ${a.score.toFixed(isCats ? 2 : 0).padStart(14)}   ${(a.survives * 100).toFixed(0).padStart(4)}%${tag}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
