/**
 * Replays a finished Hoops draft through the cards as they are now: at each of my
 * picks, the screen I would have seen on the clock — the app's pick, the tied
 * group (or the three cards) and the plan line — and who I actually took.
 *
 *   npx tsx scripts/nba-replay-cards.ts <draft.json: { slot, picks: [playerId, ...] }> [league=nba-hoops]
 */
import { readFileSync } from 'node:fs'
import { prepare, buildView, type PlayoffSchedule } from '../src/nba/plan.js'
import { emptyDraft } from '../src/nba/session.js'
import { adpFor } from '../src/nba/draft.js'

const [file, leagueId = 'nba-hoops'] = process.argv.slice(2)
const draft = JSON.parse(readFileSync(file, 'utf8')) as { slot: number; picks: string[] }
const players = JSON.parse(readFileSync('data/nba/players.json', 'utf8')).players
const league = JSON.parse(readFileSync('data/nba/leagues.json', 'utf8')).leagues.find((l: any) => l.id === leagueId)
const noise = JSON.parse(readFileSync('data/nba/category-noise.json', 'utf8')).r
const schedule: PlayoffSchedule = Object.fromEntries((JSON.parse(readFileSync('data/nba/teams.json', 'utf8')).teams as any[]).map((t) => [t.team, t.playoffGames]))
let rank = null
try { rank = JSON.parse(readFileSync(`data/nba/draft-rank/${leagueId}.json`, 'utf8')) } catch {}
const prep = prepare(league, players, noise, adpFor, schedule, null, {}, rank)
const prefs = JSON.parse(readFileSync('data/preferences/nba.json', 'utf8'))
const idOf = new Map<string, string>(players.map((p: any) => [p.name, p.id]))
const tags = new Map<string, any>()
for (const t of ['never', 'avoid', 'like']) for (const n of prefs[t] ?? []) if (idOf.has(n)) tags.set(idOf.get(n)!, t)
const name = (id: string) => prep.players.get(id)?.name ?? id
const pct = (x: number) => `${Math.round(x * 100)}%`

const n = league.teams
for (let overall = 1; overall <= draft.picks.length; overall++) {
  const round = Math.ceil(overall / n), inRound = overall - (round - 1) * n
  const seat = round % 2 ? inRound : n + 1 - inRound
  if (seat !== draft.slot) continue
  const d = emptyDraft('replay'); d.slot = draft.slot
  d.picks = draft.picks.slice(0, overall - 1).map((pid, i) => ({ overall: i + 1, playerId: pid, name: pid, source: 'manual' as const }))
  const v = buildView(prep, d, tags)
  const took = name(draft.picks[overall - 1])
  const app = v.takeNow[0]
  console.log(`\nR${round} #${overall} — took ${took}; app's pick ${app?.name ?? '—'}${app?.tiebreak ? ` (playoff tiebreak, ${app.playoff} PO g)` : ''}`)
  if (v.tied) {
    console.log(`  NEAR-TIE (${v.tied.players.length}), fit with ${v.tied.with ?? '—'}:`)
    for (const x of v.tied.players) console.log(`   ${x.appPick ? '★' : ' '} ${x.name.padEnd(24)} ${x.behind < 0.0005 ? 'top score' : '−' + x.behind.toFixed(3)}  ${x.thenName ? 'then ' + x.thenName : x.urgency === 0 ? pct(1 - x.survives) + ' gone' : 'coin flip ' + pct(x.survives) + ' back'}  ${x.adds.map((c) => (x.fills.includes(c) ? '+' : '') + c).join(' ')} ${x.costs.map((c) => '−' + c).join(' ')}`)
    if (!v.tied.players.some((x) => x.appPick)) console.log('   !! no star')
  } else {
    console.log(`  cards: ${v.takeNow.map((a, i) => `${i ? '' : '★'}${a.name} ${a.score.toFixed(3)}${a.canWait ? ' (can wait)' : ''}`).join(' · ')}`)
  }
  if (v.canWait.length) console.log(`  plan: ${app?.name} now → ${v.canWait.map((w) => `${w.name} ${pct(w.survives)}`).join(', ')}`)
}
