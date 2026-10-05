import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextNorm, contextWorthShowing, playerContext, teamLoads } from './teamLoad.js'
import type { NbaPlayer } from './types.js'

// A player with a projection and, optionally, last season on some team.
function pl(id: string, team: string, min: number, fga: number, last?: { team: string; pts: number; fga: number; min?: number }, yearsExp = 3): NbaPlayer {
  return {
    id, name: id, team, positions: ['SF'], age: 26, yearsExp, injury: null, yahoo: null, lines: {} as any,
    projection: { perGame: { min, pts: fga * 1.1, reb: 4, ast: 3, stl: 1, blk: 0.5, tpm: 1, to: 2 }, shooting: { fgPct: 0.47, ftPct: 0.8, fga, fta: 3 }, gp: 70, gpSource: 'fantasypros', sources: [] } as any,
    history: last ? [{ season: 2025, team: last.team, gp: 70, gs: 70, perGame: { min: last.min ?? 32, pts: last.pts, reb: 4, ast: 3, stl: 1, blk: 0.5, tpm: 1, to: 2 }, shooting: { fgPct: 0.47, ftPct: 0.8, fga: last.fga, fta: 3 } }] as any : [],
    durability: { seasons: 1, gpShare: 0.85 },
  } as NbaPlayer
}
const roster = (team: string, n: number, extra: NbaPlayer[] = []) => [...Array.from({ length: n }, (_, i) => pl(`${team}${i}`, team, 30 - i * 2, 12 - i, { team, pts: 14 - i, fga: 12 - i })), ...extra]

test('a team that adds a scorer is crowded, the team he left has room, and his new teammates hear about it', () => {
  const star = pl('star', 'AAA', 34, 20, { team: 'BBB', pts: 27, fga: 20 })
  const players = [...roster('AAA', 9, [star]), ...roster('BBB', 9), ...roster('CCC', 10)]
  const t = teamLoads(players)
  assert.ok(t.get('AAA')!.playsPct > 100 && t.get('BBB')!.playsPct < 100)
  assert.ok(t.get('AAA')!.netPlays > 20 && t.get('BBB')!.netPlays < -20)
  const mate = playerContext(players.find((p) => p.id === 'AAA0')!, t, null)!
  assert.deepEqual(mate.arrivals, ['star'])
  assert.equal(playerContext(star, t, null)!.from, 'BBB')
  assert.deepEqual(playerContext(players.find((p) => p.id === 'BBB0')!, t, null)!.departures, ['star'])
  assert.ok(contextWorthShowing(mate))
  // A quiet team: nothing to say.
  assert.ok(!contextWorthShowing(playerContext(players.find((p) => p.id === 'CCC0')!, t, null, contextNorm(Array.from({ length: 50 }, (_, i) => i / 10 - 2.5)))))
})

test("an unusual change is one in the league's outer tenth, not any drop", () => {
  const n = contextNorm(Array.from({ length: 101 }, (_, i) => -5 + i / 10))!
  assert.ok(Math.abs(n.median - 0) < 1e-9 && n.lo < -3.9 && n.hi > 3.9)
})
