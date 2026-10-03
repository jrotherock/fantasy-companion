/**
 * What a set of basketball mock drafts says, one league format at a time.
 *
 * Built on football's tendencies (src/kernel/tendencies.ts): the same refusal
 * to speak below a sample it can stand behind, the same strength labels, and
 * the same playbook — at most three things, each with the action, the moment
 * it applies, the picks that show it and what to check next time. The
 * questions are basketball's own:
 *
 *   strategy   which builds finish best; whether locking a punt early pays;
 *              which categories end up given away without being chosen
 *   execution  how often the advice was taken and what leaving it cost;
 *              which rounds it was left in; taking a man who would have
 *              come back while one who would not was still there
 *
 * Costs are in the league's own currency: expected categories won a week for
 * nine-cat, season value over replacement for points. A cost is the gap
 * between the advice's first choice and the pick made, in the advice's own
 * two-step score, so it already allows for who would have been there next time.
 */
import type { PlaybookItem, Tendency } from '../kernel/tendencies.js'
import type { Cat } from './value.js'

export const CAT_NAME: Record<Cat, string> = {
  fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO',
}

export interface MockPick {
  overall: number
  round: number
  took: string
  tookPositions: string[]
  /** The advice's first choice, where the screen was open for that turn. */
  advised: string | null
  advisedPositions: string[]
  /** Advice score of the first choice less that of the pick made; null where unknown. */
  cost: number | null
  /** I took a man the advice expected back next turn, while its first choice would not be. */
  waitedWrong: boolean
  stage: 'open' | 'leaning' | 'firm' | null
}

export interface MockRecord {
  id: string
  when: number
  seat: number | null
  /** Expected categories won a week (nine-cat) or season value over replacement (points). */
  result: number
  /** Points leagues: the roster's fantasy points over the season, a game times games. */
  fpSeason?: number | null
  /** Where my roster finished in the room on the result, and on season points; and out of how many teams. */
  place?: { result: number; fpSeason: number | null; of: number } | null
  /** Categories under a 35% weekly win chance at the end. */
  punting: Cat[]
  win: Record<Cat, number> | null
  locks: Cat[]
  /** First of my picks made with a punt locked; null if never locked. */
  lockedFromRound: number | null
  picks: MockPick[]
}

export interface MockReport {
  mocks: number
  scoring: 'categories' | 'points'
  unit: string
  headline: string
  playbook: PlaybookItem[]
  tendencies: Tendency[]
  byBuild: { build: string; mocks: number; avg: number }[]
  byRound: { round: number; picks: number; avgCost: number; worst: { took: string; advised: string; cost: number } | null }[]
  table: { id: string; when: number; seat: number | null; build: string; result: number; fpSeason: number | null; place: { result: number; fpSeason: number | null; of: number } | null; followed: string; cost: number }[]
  caveat: string
}

const strength = (n: number): Tendency['strength'] => (n >= 5 ? 'clear' : n >= 3 ? 'suggestive' : 'thin')
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const buildName = (punting: Cat[]) => (punting.length ? `punt ${punting.map((c) => CAT_NAME[c]).join(' + ')}` : 'balanced')
/** A locked punt names the build — it was the decision; otherwise it is what the roster ended up giving away. */
const buildOf = (m: { locks: Cat[]; punting: Cat[] }) => (m.locks.length ? `${buildName(m.locks)} (locked)` : buildName(m.punting))
const isBig = (ps: string[]) => ps.includes('C')
const isGuard = (ps: string[]) => ps.includes('PG') || (ps.includes('SG') && !ps.includes('PF'))

/** Fewer than this many finished mocks and the report says so rather than guessing. */
export const MIN_MOCKS = 2

export function analyseMocks(mocks: MockRecord[], scoring: 'categories' | 'points'): MockReport {
  const cats = scoring === 'categories'
  const unit = cats ? 'categories a week' : 'value'
  const fmt = (x: number) => (cats ? x.toFixed(2) : Math.round(x).toString())
  const picks = mocks.flatMap((m) => m.picks.map((p) => ({ ...p, mock: m })))
  const known = picks.filter((p) => p.cost != null)
  const departures = known.filter((p) => p.advised && p.advised !== p.took)

  const table = [...mocks].sort((a, b) => b.when - a.when).map((m) => {
    const k = m.picks.filter((p) => p.cost != null)
    return {
      id: m.id, when: m.when, seat: m.seat, build: cats ? buildOf(m) : '—', result: m.result, fpSeason: m.fpSeason ?? null, place: m.place ?? null,
      followed: `${k.filter((p) => p.advised === p.took).length}/${k.length}`,
      cost: k.reduce((n, p) => n + (p.cost ?? 0), 0),
    }
  })

  const byBuildMap = new Map<string, number[]>()
  for (const m of mocks) {
    const b = cats ? buildOf(m) : 'all'
    byBuildMap.set(b, [...(byBuildMap.get(b) ?? []), m.result])
  }
  const byBuild = [...byBuildMap].map(([build, rs]) => ({ build, mocks: rs.length, avg: mean(rs) })).sort((a, b) => b.avg - a.avg)

  const rounds = [...new Set(known.map((p) => p.round))].sort((a, b) => a - b)
  const byRound = rounds.map((round) => {
    const here = known.filter((p) => p.round === round)
    const worst = here.filter((p) => p.advised !== p.took).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0]
    return {
      round, picks: here.length, avgCost: mean(here.map((p) => p.cost ?? 0)),
      worst: worst ? { took: worst.took, advised: worst.advised!, cost: worst.cost ?? 0 } : null,
    }
  })

  const caveat = `Mock rooms are Yahoo's bots, which draft roughly down Yahoo's rankings — they test the method more than your league-mates' habits. Only turns the draft screen was open for are scored.`

  if (mocks.length < MIN_MOCKS) {
    return {
      mocks: mocks.length, scoring, unit, playbook: [], tendencies: [], byBuild, byRound, table, caveat,
      headline: mocks.length
        ? `One finished mock so far — its review is on its own page. Patterns need at least ${MIN_MOCKS}.`
        : 'No finished mocks yet.',
    }
  }

  const tendencies: Tendency[] = []
  const playbook: PlaybookItem[] = []
  const n = mocks.length

  // ── Execution: what leaving the advice cost ──
  const totalCost = departures.reduce((s, p) => s + (p.cost ?? 0), 0)
  const perMock = totalCost / n
  if (known.length >= 6) {
    const rate = 1 - departures.length / known.length
    const worst = [...departures].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 2)
    tendencies.push({
      id: 'adherence',
      headline: `You took the advice at ${Math.round(rate * 100)}% of your picks`,
      detail: departures.length
        ? `Going your own way cost ${fmt(perMock)} ${unit} per mock on the advice's own reckoning. Costliest: ${worst.map((p) => `${p.took} over ${p.advised} (R${p.round}, ${fmt(p.cost ?? 0)})`).join('; ')}.`
        : 'Every scored pick was the advice\'s first choice, so there is nothing to compare it against yet.',
      drafts: n, strength: strength(n),
      tryNext: departures.length ? 'In one mock, take the first choice every time, and compare the finish with your own.' : 'In one mock, overrule the advice wherever you disagree, so the two can be compared.',
    })
    const threshold = cats ? 0.05 : 25
    if (perMock >= threshold && worst[0]) {
      playbook.push({
        id: 'follow',
        action: 'Take the first choice unless you can name what it gets wrong',
        when: 'Every pick, but especially the rounds below where the gap has been widest',
        because: `Across ${n} mocks, picks away from the advice cost ${fmt(perMock)} ${unit} per draft — e.g. ${worst[0].took} over ${worst[0].advised} in round ${worst[0].round}.`,
        check: `Next mock: departures should cost under ${fmt(perMock / 2)} in total.`,
        worth: perMock, strength: strength(n),
      })
    }
  }

  // Rounds where the gap concentrates.
  const costly = byRound.filter((r) => r.picks >= 2).sort((a, b) => b.avgCost - a.avgCost)[0]
  if (costly && costly.avgCost > (cats ? 0.03 : 15)) {
    tendencies.push({
      id: 'round', headline: `Round ${costly.round} is where it slips`,
      detail: `${fmt(costly.avgCost)} ${unit} lost per pick there on average${costly.worst ? `; worst was ${costly.worst.took} over ${costly.worst.advised}` : ''}.`,
      drafts: n, strength: strength(costly.picks),
      tryNext: `Before round ${costly.round}, read the targets list for that pick ahead of time.`,
    })
  }

  // Waiting on the wrong man: took someone likely back next turn while the first choice was not.
  const waited = known.filter((p) => p.waitedWrong)
  if (waited.length >= 2) {
    const w = waited.slice(0, 2)
    tendencies.push({
      id: 'wait', headline: `${waited.length} times you took a player who would have come back`,
      detail: `While the advice's first choice would not have: ${w.map((p) => `${p.took} over ${p.advised} (R${p.round})`).join('; ')}.`,
      drafts: new Set(waited.map((p) => p.mock.id)).size, strength: strength(waited.length),
      tryNext: 'Check the "can wait" mark before taking someone: if he is marked, take the player who is not.',
    })
    playbook.push({
      id: 'wait',
      action: 'Take the player who will be gone; draft the one marked "can wait" next turn',
      when: 'Whenever your choice carries the "can wait" mark',
      because: `${waited.length} times across your mocks — e.g. ${w[0].took} over ${w[0].advised} in round ${w[0].round}.`,
      check: 'Next mock: no pick of a "can wait" player while a "gone by your next turn" one is still listed.',
      worth: waited.reduce((s, p) => s + (p.cost ?? 0), 0) / n, strength: strength(waited.length),
    })
  }

  // Position drift when leaving the advice.
  const swaps = departures.filter((p) => p.advisedPositions.length)
  const guardForBig = swaps.filter((p) => isGuard(p.tookPositions) && isBig(p.advisedPositions)).length
  const bigForGuard = swaps.filter((p) => isBig(p.tookPositions) && isGuard(p.advisedPositions)).length
  if (Math.max(guardForBig, bigForGuard) >= 3) {
    const g = guardForBig >= bigForGuard
    tendencies.push({
      id: 'drift', headline: g ? 'When you leave the advice, you take a guard over a big' : 'When you leave the advice, you take a big over a guard',
      detail: `${g ? guardForBig : bigForGuard} of ${swaps.length} departures went that way. That was last season's lesson too — mid-round guards against a punt-assists build.`,
      drafts: n, strength: strength(g ? guardForBig : bigForGuard),
      tryNext: g ? 'When you want a guard over the advised big, check what the build panel says it costs first.' : 'When you want a big over the advised guard, check the build panel first.',
    })
  }

  // ── Strategy ──
  if (cats) {
    // Which builds finish best, when there is more than one to compare.
    const comparable = byBuild.filter((b) => b.mocks >= 1)
    if (comparable.length >= 2) {
      const [best, ...rest] = comparable
      const worst = rest[rest.length - 1]
      tendencies.push({
        id: 'builds', headline: `${best.build} finished best (${fmt(best.avg)} ${unit})`,
        detail: comparable.map((b) => `${b.build}: ${fmt(b.avg)} over ${b.mocks}`).join(' · '),
        drafts: n, strength: strength(Math.min(best.mocks, worst.mocks) * 2),
        tryNext: best.mocks < 3 ? `Run ${best.build} again to see if it holds.` : `Lock ${best.build} by round 4 next mock and compare.`,
      })
      if (best.mocks >= 2 && best.avg - worst.avg >= 0.3) {
        playbook.push({
          id: 'build',
          action: `Steer toward ${best.build}`,
          when: 'From your fourth pick, when the build panel first reads',
          because: `It averaged ${fmt(best.avg)} against ${fmt(worst.avg)} for ${worst.build}, over ${best.mocks} and ${worst.mocks} mocks.`,
          check: `Next mock: finish at or above ${fmt(best.avg)}.`,
          worth: best.avg - worst.avg, strength: strength(best.mocks),
        })
      }
    }

    // Categories given away without being chosen.
    const counts = new Map<Cat, number>()
    for (const m of mocks) for (const c of m.punting) if (!m.locks.includes(c)) counts.set(c, (counts.get(c) ?? 0) + 1)
    const drifted = [...counts].filter(([, k]) => k >= Math.max(2, Math.ceil(n / 2))).sort((a, b) => b[1] - a[1])
    if (drifted.length) {
      const [c, k] = drifted[0]
      tendencies.push({
        id: 'drifted', headline: `${CAT_NAME[c]} ends up punted without being chosen`,
        detail: `In ${k} of ${n} mocks it finished under a 35% weekly win chance with no lock on it.`,
        drafts: n, strength: strength(k),
        tryNext: `Decide by round 4: lock ${CAT_NAME[c]} and draft for the rest, or treat it as a need.`,
      })
      playbook.push({
        id: 'drifted',
        action: `Lock ${CAT_NAME[c]} as a punt by round 4, or draft for it on purpose`,
        when: 'When the build panel first reads, at your fourth pick',
        because: `It drifted below 35% in ${k} of ${n} mocks without being locked, so you paid for it in early rounds and still lost it.`,
        check: `Next mock: ${CAT_NAME[c]} is either locked or above 50% at the end.`,
        worth: 0.25 * k / n, strength: strength(k),
      })
    }

    // Early versus late locks.
    const early = mocks.filter((m) => m.lockedFromRound != null && m.lockedFromRound <= 4)
    const late = mocks.filter((m) => m.lockedFromRound == null || m.lockedFromRound > 4)
    if (early.length >= 2 && late.length >= 2) {
      const d = mean(early.map((m) => m.result)) - mean(late.map((m) => m.result))
      tendencies.push({
        id: 'locks', headline: d >= 0 ? 'Locking a punt by round 4 has finished better' : 'Keeping the build open past round 4 has finished better',
        detail: `Locked by round 4: ${fmt(mean(early.map((m) => m.result)))} over ${early.length}; later or never: ${fmt(mean(late.map((m) => m.result)))} over ${late.length}.`,
        drafts: n, strength: strength(Math.min(early.length, late.length) * 2),
        tryNext: d >= 0 ? 'Lock by round 4 again and see if the gap holds.' : 'Leave the build open until the panel turns firm at pick 9.',
      })
    }
  }

  // Seat effect, once several seats have been tried.
  const seats = new Map<number, number[]>()
  for (const m of mocks) if (m.seat != null) seats.set(m.seat, [...(seats.get(m.seat) ?? []), m.result])
  if (seats.size >= 3) {
    const rows = [...seats].map(([seat, rs]) => ({ seat, avg: mean(rs), k: rs.length })).sort((a, b) => b.avg - a.avg)
    tendencies.push({
      id: 'seats', headline: `Best finishes from seat ${rows[0].seat}`,
      detail: rows.map((r) => `seat ${r.seat}: ${fmt(r.avg)} (${r.k})`).join(' · '),
      drafts: n, strength: 'thin',
      tryNext: 'Your real seat is Yahoo\'s to set; practise from the seat you are given once it is known.',
    })
  }

  playbook.sort((a, b) => b.worth - a.worth)
  const best = byBuild[0]
  return {
    mocks: n, scoring, unit, tendencies, byBuild, byRound, table, caveat,
    playbook: playbook.slice(0, 3),
    headline: cats
      ? `${n} mocks · average ${fmt(mean(mocks.map((m) => m.result)))} ${unit}${best ? ` · best build so far: ${best.build}` : ''}`
      : `${n} mocks · average season value ${fmt(mean(mocks.map((m) => m.result)))}`,
  }
}
