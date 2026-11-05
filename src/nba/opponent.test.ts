import { test } from 'node:test'
import assert from 'node:assert/strict'
import { againstTeam, allowedFrom, groupOf, oppFactor, OPP_PRIOR_GAMES, STATS, type Allowed } from './opponent.js'
import type { GameLog } from './outlook.js'
import type { Game } from './types.js'

const box = (pts: number, stl = 1) => ({ fgm: pts / 2.5, fga: pts / 1.1, ftm: 2, fta: 2.5, tpm: 2, pts, reb: 4, ast: 4, stl, blk: 0.5, to: 2 })

// Guards score 30 points in 30 minutes against SOFT and 15 against HARD; both teams play AVG too, which allows 22.
const days = Array.from({ length: 12 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
const schedule: Game[] = days.flatMap((date, i) => [
  { id: `a${i}`, date, home: 'SOFT', away: 'X' },
  { id: `b${i}`, date, home: 'HARD', away: 'Y' },
  { id: `c${i}`, date, home: 'AVG', away: 'Z' },
]) as Game[]
const logs: GameLog[] = days.flatMap((date) => [
  { id: 'x', date, team: 'X', min: 30, box: box(30, 2) },
  { id: 'y', date, team: 'Y', min: 30, box: box(15, 0.5) },
  { id: 'z', date, team: 'Z', min: 30, box: box(22, 1) },
  { id: 'big', date, team: 'X', min: 30, box: box(10) },
])
const group = (id: string) => (id === 'big' ? 'C' as const : 'G' as const)

test('opponent: a team that gives up more to guards moves a guard up, one that gives up less moves him down', () => {
  const now = allowedFrom(logs, schedule, group)
  assert.equal(now.games.SOFT, 12)
  // Against the league (all three teams), points per minute: SOFT 30/22.33, HARD 15/22.33.
  const lg = (30 + 15 + 22) / 3
  const soft = oppFactor(now, null, 'SOFT', 'G', 'pts', 1), hard = oppFactor(now, null, 'HARD', 'G', 'pts', 1)
  assert.ok(Math.abs(soft - (12 * (30 / lg) + OPP_PRIOR_GAMES) / (12 + OPP_PRIOR_GAMES)) < 1e-9, `soft ${soft}`)
  assert.ok(soft > 1 && hard < 1)
  // Half strength moves half as far.
  assert.ok(Math.abs(oppFactor(now, null, 'SOFT', 'G', 'pts', 0.5) - (1 + (soft - 1) / 2)) < 1e-9)
  assert.equal(oppFactor(now, null, 'SOFT', 'G', 'pts', 0), 1)
  // Centers are their own group: a center against SOFT is judged against centers, and there is only one.
  assert.ok(Math.abs(oppFactor(now, null, 'SOFT', 'C', 'pts', 1) - 1) < 1e-9)
  // A whole line moves stat by stat.
  const line = againstTeam(box(20), now, null, 'SOFT', 'G', 1)
  for (const s of STATS) assert.ok(Math.abs(line[s] - box(20)[s] * oppFactor(now, null, 'SOFT', 'G', s, 1)) < 1e-9, s)
  assert.ok(line.stl > box(20).stl, 'steals too')
})

test("opponent: last season starts a team off; this season's games take over as they come; nothing seen is no change", () => {
  const empty = allowedFrom([], schedule, group)
  assert.equal(oppFactor(empty, null, 'SOFT', 'G', 'pts', 1), 1, 'nothing known')
  // Last season: SOFT gave guards twice the league's points a minute.
  const prior: Allowed = {
    league: { G: { min: 1000, s: Object.fromEntries(STATS.map((s) => [s, 500])) as any }, F: { min: 0, s: {} as any }, C: { min: 0, s: {} as any } },
    teams: { 'SOFT|G': { min: 1000, s: Object.fromEntries(STATS.map((s) => [s, 1000])) as any } }, games: { SOFT: 82 },
  }
  assert.ok(Math.abs(oppFactor(empty, prior, 'SOFT', 'G', 'pts', 1) - 2) < 1e-9, 'last season alone')
  assert.ok(Math.abs(oppFactor(empty, prior, 'SOFT', 'G', 'pts', 0.5) - 1.5) < 1e-9)
  // Twelve games this season at 30/22.33: weighed 12 against 20 of last season's 2.0.
  const now = allowedFrom(logs, schedule, group)
  const lg = (30 + 15 + 22) / 3
  assert.ok(Math.abs(oppFactor(now, prior, 'SOFT', 'G', 'pts', 1) - (12 * (30 / lg) + 20 * 2) / 32) < 1e-9)
  // Too few minutes against a group says nothing yet.
  const one = allowedFrom(logs.slice(0, 4), schedule, group)
  assert.ok(Math.abs(oppFactor(one, prior, 'SOFT', 'G', 'pts', 1) - 2) < 1e-9, 'one game of 30 minutes is not enough')
  assert.equal(groupOf(['C']), 'C'); assert.equal(groupOf(['PF', 'C']), 'F'); assert.equal(groupOf(['SG']), 'G'); assert.equal(groupOf(undefined), 'G')
})
