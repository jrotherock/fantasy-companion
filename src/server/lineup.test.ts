import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advise, bestLineup, slotsFor, type Candidate } from './lineup.js'

const STEWARD = slotsFor(
  { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 },
  [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 }],
)
const p = (
  name: string, pos: string, projected: number, starter: boolean,
  injuryStatus: string | null = null,
) => ({ id: name, name, pos, projected, starter, injuryStatus })

// The real lineup, as captured from Yahoo on 4 September 2026.
const squad = [
  p('Bo Nix', 'QB', 16.65, true), p('James Cook III', 'RB', 13.38, true),
  p('Derrick Henry', 'RB', 13.42, true), p('Jaylen Waddle', 'WR', 11.29, true),
  p('Ladd McConkey', 'WR', 10.72, true), p('Dallas Goedert', 'TE', 7.98, true),
  p('Christian Watson', 'WR', 10.21, true), p('Will Reichard', 'K', 9.2, true),
  p('Vikings', 'DST', 6.23, true), p('Rhamondre Stevenson', 'RB', 9.32, false),
  p('MarShawn Lloyd', 'RB', 10.17, false), p('Michael Wilson', 'WR', 7.6, false),
  p('Mike Washington Jr.', 'RB', 4.94, false),
]

test('leaves an already optimal lineup alone', () => {
  const out = advise(STEWARD, squad)
  assert.equal(out.swaps.length, 0)
  assert.equal(out.gain, 0)
  assert.equal(out.current.toFixed(2), '99.08')
})

test('benches a starter who cannot play, however he projects', () => {
  // Henry is the highest-projected back on the roster and is ruled out.
  const hurt = squad.map((x) => (x.name === 'Derrick Henry' ? { ...x, injuryStatus: 'OUT' } : x))
  const out = advise(STEWARD, hurt)
  const move = out.swaps.find((s) => s.out?.name === 'Derrick Henry')
  assert.ok(move, 'expected Henry to be replaced')
  assert.equal(move!.in.name, 'MarShawn Lloyd')
  assert.equal(move!.reason, 'out')
})

test('promotes a bench player who simply projects higher', () => {
  const weak = squad.map((x) => (x.name === 'Christian Watson' ? { ...x, projected: 3.0 } : x))
  const out = advise(STEWARD, weak)
  assert.equal(out.swaps[0].in.name, 'MarShawn Lloyd')
  assert.equal(out.swaps[0].slot, 'W/R/T')
  assert.equal(out.swaps[0].gain.toFixed(2), '7.17')
})

test('respects position eligibility — no kicker in the flex', () => {
  const odd = [...squad, p('Spare Kicker', 'K', 99, false)]
  const out = advise(STEWARD, odd)
  assert.ok(out.swaps.every((s) => s.slot !== 'W/R/T' || s.in.pos !== 'K'))
})

test('handles the IDP league shape', () => {
  const idp = slotsFor(
    { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DB: 2, DL: 2, LB: 2 },
    [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 },
     { name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }],
  )
  assert.equal(idp.length, 15)
  const out = advise(idp, [p('A Safety', 'DB', 12, false), p('A Weak DB', 'DB', 2, true)])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].in.name, 'A Safety')
})

test('the IDP league fields a full fifteen, D flex included', () => {
  const slots = slotsFor(
    { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DB: 2, DL: 2, LB: 2 },
    [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 },
     { name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }],
  )
  const squad = [
    p('QB1', 'QB', 18, true), p('RB1', 'RB', 14, true), p('RB2', 'RB', 12, true),
    p('WR1', 'WR', 13, true), p('WR2', 'WR', 11, true), p('TE1', 'TE', 8, true),
    p('FLEX', 'WR', 10, true), p('K1', 'K', 9, true),
    p('DB1', 'DB', 9, true), p('DB2', 'DB', 8, true),
    p('DL1', 'DL', 7, true), p('DL2', 'DL', 6, true),
    p('LB1', 'LB', 12, true), p('LB2', 'LB', 11, true),
    p('LB3', 'LB', 10, true),   // the D flex
  ]
  const out = advise(slots, squad)
  assert.equal(out.swaps.length, 0, 'a full, correct fifteen needs no changes')
  assert.equal(out.current, 158)
})

test('the D flex takes the best defender left, not a receiver', () => {
  const slots = slotsFor({ DB: 1 }, [{ name: 'D', eligible: ['DB', 'DL', 'LB'], count: 1 }])
  const out = advise(slots, [
    p('starterDB', 'DB', 5, true),
    p('benchLB', 'LB', 11, false),
    p('benchWR', 'WR', 30, false),
  ])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].in.name, 'benchLB')
  assert.equal(out.swaps[0].slot, 'D')
})

/* ------------------------------------------------- close calls and tiebreaks */

const cand = (o: Partial<Candidate> & { id: string }): Candidate => ({
  name: o.id, pos: 'RB', projected: 10, injuryStatus: null, starter: false, ...o,
})

test('a difference the projections cannot see is called a coin flip', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'starting', projected: 9.5, starter: true }),
    cand({ id: 'bench', projected: 10.1 }),
  ])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].close, true, '0.6 apart is inside the noise')
  assert.equal(out.decisive, 0, 'nothing decisive is on the table')
})

test('a real gap is not a coin flip', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'starting', projected: 6, starter: true }),
    cand({ id: 'bench', projected: 12 }),
  ])
  assert.equal(out.swaps[0].close, false)
  assert.equal(out.decisive, 6)
})

test('a player ruled out is never a coin flip, however small the gain', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'hurt', projected: 9.9, starter: true, injuryStatus: 'Out' }),
    cand({ id: 'fit', projected: 0.5 }),
  ])
  assert.equal(out.swaps[0].reason, 'out')
  assert.equal(out.swaps[0].close, false)
})

test('consensus breaks a tie the projections cannot, and only then', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // Half a point apart: the lower projection with the better expert rank wins.
  const inside = bestLineup(slots, [
    cand({ id: 'higher-proj', projected: 10.1, weekRank: 30 }),
    cand({ id: 'better-rank', projected: 9.6, weekRank: 4 }),
  ])
  assert.equal([...inside.values()][0].id, 'better-rank')

  // Six points apart: the projection is not in doubt, so rank is ignored.
  const outside = bestLineup(slots, [
    cand({ id: 'higher-proj', projected: 16, weekRank: 30 }),
    cand({ id: 'better-rank', projected: 9.6, weekRank: 4 }),
  ])
  assert.equal([...outside.values()][0].id, 'higher-proj')
})

test('the defence faced breaks a tie the consensus cannot', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // Same projection band, no consensus either way: the softer defence wins.
  const out = bestLineup(slots, [
    cand({ id: 'hard-matchup', projected: 10.1, dvpRank: 31 }),
    cand({ id: 'soft-matchup', projected: 9.7, dvpRank: 3 }),
  ])
  assert.equal([...out.values()][0].id, 'soft-matchup')
})

test('the consensus outranks the matchup when they disagree', () => {
  const slots = slotsFor({ RB: 1 }, [])
  const out = bestLineup(slots, [
    cand({ id: 'experts-like-him', projected: 10.0, weekRank: 5, dvpRank: 31 }),
    cand({ id: 'soft-matchup', projected: 9.8, weekRank: 26, dvpRank: 2 }),
  ])
  assert.equal([...out.values()][0].id, 'experts-like-him')
})

test('the tiebreak never makes the headline negative', () => {
  const slots = slotsFor({ RB: 1 }, [])
  // The consensus prefers the lower projection; the gain must not go below zero.
  const out = advise(slots, [
    cand({ id: 'starting', projected: 10.2, weekRank: 30, starter: true }),
    cand({ id: 'bench', projected: 9.3, weekRank: 6 }),
  ])
  assert.ok(out.gain >= 0, `gain was ${out.gain}`)
  assert.equal(out.decisive, 0, 'nothing decisive when the only move is inside the noise')
  assert.equal(out.swaps[0]?.close, true)
})

test('when one bench player rivals several slots, the call needing a decision survives', () => {
  const slots = slotsFor({ WR: 1 }, [{ name: 'W/R/T', eligible: ['RB', 'WR'], count: 1 }])
  const out = advise(slots, [
    // A tight call already resolved the way the lineup is set…
    cand({ id: 'in-wr', pos: 'WR', projected: 10.7, weekRank: 16, starter: true }),
    // …and a looser one that wants somebody moved off the bench.
    cand({ id: 'in-flex', pos: 'WR', projected: 10.2, weekRank: 24, starter: true }),
    cand({ id: 'benched', pos: 'RB', projected: 9.3, weekRank: 21 }),
  ])
  assert.equal(out.closeCalls.length >= 1, true)
  assert.ok(
    out.closeCalls.some((c) => !c.keep.starter),
    'the call that needs a substitution must survive the dedupe',
  )
})

test('a doubtful starter scores nothing, and is swapped out for anyone fit', () => {
  const slots = slotsFor({ TE: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'bowers', pos: 'TE', projected: 11.5, injuryStatus: 'Doubtful', starter: true }),
    cand({ id: 'anyone', pos: 'TE', projected: 4.2 }),
  ])
  assert.equal(out.swaps.length, 1)
  assert.equal(out.swaps[0].reason, 'out', 'doubtful is a hole, not a close call')
  assert.equal(out.swaps[0].close, false)
  assert.equal(out.gain, 4.2, 'the doubtful man contributes nothing to the total')
})

test('questionable is still taken at face value', () => {
  const slots = slotsFor({ TE: 1 }, [])
  const out = advise(slots, [
    cand({ id: 'q', pos: 'TE', projected: 11.5, injuryStatus: 'Questionable', starter: true }),
    cand({ id: 'fit', pos: 'TE', projected: 4.2 }),
  ])
  assert.equal(out.swaps.length, 0, 'fifty-nine ranked players carry one in August')
})

/*
 * A week that has begun.
 *
 * The board told me to start Michael Wilson over A.J. Brown on the Saturday,
 * for a receiver who had played on the Thursday and scored — advice about a
 * decision that closed at kickoff. It was worst on a stale designation: ruled
 * out on paper, worth nought to the optimiser, so the whole of the bench man's
 * projection read as points going begging.
 *
 * Each of these carries its control, because the useful half of the assertion
 * is that the move exists until the lock removes it. Without that, locking a
 * man the optimiser was never going to touch proves nothing at all.
 */
const locked = (c: Candidate): Candidate => ({ ...c, locked: true })
const swap = (squad: Candidate[]) => advise(STEWARD, squad).swaps

test('a man who has played is not offered up for benching', () => {
  const out = squad.map((c) =>
    c.name === 'Jaylen Waddle' ? { ...c, injuryStatus: 'Out' } : c)
  assert.equal(
    swap(out).some((s) => s.out?.name === 'Jaylen Waddle'), true,
    'control: ruled out and still to play, he is the obvious man to replace',
  )
  const played = out.map((c) => (c.name === 'Jaylen Waddle' ? locked(c) : c))
  assert.equal(
    swap(played).some((s) => s.out?.name === 'Jaylen Waddle'), false,
    'his slot is settled, whatever the projection says about it',
  )
})

test('a locked starter holds his slot rather than leaving a hole', () => {
  const played = squad.map((c) =>
    c.name === 'Jaylen Waddle' ? locked({ ...c, injuryStatus: 'Out' }) : c)
  assert.equal(
    swap(played).some((s) => s.reason === 'empty'), false,
    'an occupied slot is not an empty one',
  )
})

test('a bench player whose game has gone cannot be brought in', () => {
  // Comfortably better than the man in the flex, so the optimiser wants him.
  const strong = squad.map((c) =>
    c.name === 'Michael Wilson' ? { ...c, projected: 15.4 } : c)
  assert.equal(
    swap(strong).some((s) => s.in.name === 'Michael Wilson'), true,
    'control: on projection alone he walks into the lineup',
  )
  const gone = strong.map((c) => (c.name === 'Michael Wilson' ? locked(c) : c))
  assert.equal(
    swap(gone).some((s) => s.in.name === 'Michael Wilson'), false,
    'four points of upgrade are not available if his game is over',
  )
})

test('a close call whose slot has kicked off is no longer a call', () => {
  /*
   * Its own two-man squad rather than a tweak to the one above, because in
   * that lineup a locked receiver is frozen into a dedicated slot where his
   * nearest rival is nowhere near him — so the assertion passed for reasons
   * that had nothing to do with the lock, and went on passing with the guard
   * taken out. One slot, two men, half a point between them: nothing else can
   * account for the answer.
   */
  const ONE_WR = slotsFor({ WR: 1 }, [])
  const pair = (lock: boolean): Candidate[] => [
    { id: 'a', name: 'Starter', pos: 'WR', projected: 10, starter: true,
      injuryStatus: null, locked: lock },
    { id: 'b', name: 'Bench', pos: 'WR', projected: 9.5, starter: false,
      injuryStatus: null },
  ]
  assert.equal(
    advise(ONE_WR, pair(false)).closeCalls.length, 1,
    'control: half a point apart is exactly what a close call is',
  )
  assert.equal(
    advise(ONE_WR, pair(true)).closeCalls.length, 0,
    'the projections may be level and the matter is still settled',
  )
})

test('with nobody locked the advice is exactly what it always was', () => {
  const before = advise(STEWARD, squad)
  assert.equal(before.swaps.length, 0)
  assert.equal(before.current.toFixed(2), '99.08')
})

test('a bigger role breaks a tie the projection cannot', () => {
  /*
   * Measured on 2025 under this league's scoring: among pairs a projection
   * called level, the man with the larger share of his team's opportunities
   * outscored the other about two times in three.
   *
   * The bench man is projected higher on purpose. Without the role the
   * projection decides and he is promoted, so the test fails the moment the
   * tiebreak stops working — the first version had him winning either way and
   * quietly proved nothing.
   */
  const ONE_WR = slotsFor({ WR: 1 }, [])
  const pair = (keepRole: number, benchRole: number): Candidate[] => [
    { id: 'in', name: 'In lineup', pos: 'WR', projected: 10, starter: true,
      injuryStatus: null, role: keepRole },
    { id: 'out', name: 'On bench', pos: 'WR', projected: 10.4, starter: false,
      injuryStatus: null, role: benchRole },
  ]
  const held = advise(ONE_WR, pair(0.20, 0.06))
  assert.equal(held.swaps.length, 0, 'seven points of his own offence outweigh four tenths of a projection')
  assert.equal(held.closeCalls[0]?.by, 'role')

  // Two points apart is noise: the projection gets the last word again.
  const noise = advise(ONE_WR, pair(0.13, 0.15))
  assert.equal(noise.swaps[0]?.in.name, 'On bench')
  assert.notEqual(noise.closeCalls[0]?.by, 'role')
})

test('role never overrules a projection that has actually separated them', () => {
  const ONE_WR = slotsFor({ WR: 1 }, [])
  const squad: Candidate[] = [
    { id: 'in', name: 'Clear starter', pos: 'WR', projected: 14, starter: true,
      injuryStatus: null, role: 0.05 },
    { id: 'out', name: 'Bigger role', pos: 'WR', projected: 9, starter: false,
      injuryStatus: null, role: 0.30 },
  ]
  assert.equal(advise(ONE_WR, squad).swaps.length, 0,
    'five points is not a coin flip, whatever the usage says')
})

test('consensus still outranks role', () => {
  /*
   * This is the ordinary case, not the exception. Every close call across five
   * real leagues came down to consensus, with rank gaps of seven to
   * twenty-nine places — WR21 against WR39 is an opinion, not a tie. Role
   * speaks where the consensus has nothing to say.
   */
  const ONE_WR = slotsFor({ WR: 1 }, [])
  const squad: Candidate[] = [
    { id: 'in', name: 'Ranked higher', pos: 'WR', projected: 10, starter: true,
      injuryStatus: null, weekRank: 12, role: 0.06 },
    { id: 'out', name: 'Bigger role', pos: 'WR', projected: 10.1, starter: false,
      injuryStatus: null, weekRank: 30, role: 0.20 },
  ]
  const out = advise(ONE_WR, squad)
  assert.equal(out.swaps.length, 0, 'the whole second opinion leads')
  assert.equal(out.closeCalls[0]?.by, 'consensus')
})

test('a gap the projection has an opinion about is still returned, marked as such', () => {
  /*
   * Measured over 2024 and 2025, a three-point edge is right about three times
   * in five — so the pair is worth looking at, but the projection did decide
   * it, and the card must not claim otherwise.
   */
  const slots = slotsFor({ QB: 1 }, [])
  const calls = advise(slots, [
    { id: 'love', name: 'Jordan Love', pos: 'QB', projected: 19.6, injuryStatus: null, starter: true },
    { id: 'law', name: 'Trevor Lawrence', pos: 'QB', projected: 17.2, injuryStatus: null, starter: false },
  ]).closeCalls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tight, false, 'outside the coin flip')
  assert.equal(calls[0].by, 'projection', 'the projection decided it, whatever else is known')
  assert.equal(calls[0].gap, 2.4)
})

test('past three points there is nothing to reopen', () => {
  const slots = slotsFor({ QB: 1 }, [])
  assert.deepEqual(advise(slots, [
    { id: 'a', name: 'A', pos: 'QB', projected: 20, injuryStatus: null, starter: true },
    { id: 'b', name: 'B', pos: 'QB', projected: 16.9, injuryStatus: null, starter: false },
  ]).closeCalls, [])
})

test('a defensive call gets the wider band its projections earn', () => {
  /*
   * Measured on 64,674 IDP pairs under this league's settings: four to five
   * points apart, the lower-projected defender still wins 39% of them. The
   * same gap between two receivers is settled enough to leave alone.
   */
  const idp = advise(slotsFor({ LB: 1 }, []), [
    { id: 'a', name: 'Landman', pos: 'LB', projected: 14.0, injuryStatus: null, starter: true },
    { id: 'b', name: 'Wilson', pos: 'LB', projected: 10.5, injuryStatus: null, starter: false },
  ]).closeCalls
  assert.equal(idp.length, 1, 'three and a half points apart is still a question for a linebacker')
  assert.equal(idp[0].tight, false)

  const wr = advise(slotsFor({ WR: 1 }, []), [
    { id: 'c', name: 'Smith', pos: 'WR', projected: 14.0, injuryStatus: null, starter: true },
    { id: 'd', name: 'Jones', pos: 'WR', projected: 10.5, injuryStatus: null, starter: false },
  ]).closeCalls
  assert.deepEqual(wr, [], 'the same gap between receivers is decided')
})

test('a projection nobody read is not a projection of nought', () => {
  /*
   * Yahoo prints a projection for a man until his game is over, and the sensor
   * reads sixteen of seventeen on a good day. The seventeenth was valued at
   * nought like everyone else, so the linebacker replacing him looked worth
   * his whole projection: "+14.2 on the table" for a swap whose other half
   * was simply unknown.
   */
  const unread = { id: 'Devin Bush', name: 'Devin Bush', pos: 'RB', projected: null, starter: true, injuryStatus: null }
  const out = advise(STEWARD, [
    ...squad.filter((c) => c.name !== 'Mike Washington Jr.' && c.name !== 'Rhamondre Stevenson'),
    unread as unknown as Candidate,
    p('Nate Landman', 'RB', 14.21, false),
  ])
  const swap = out.swaps.find((s) => s.in.name === 'Nate Landman')!
  assert.equal(swap.out?.name, 'Devin Bush')
  assert.equal(swap.unknownOut, true, 'the swap is a question, not a gain')
  assert.equal(swap.close, false, 'nor is a blank a coin flip')
  assert.equal(out.decisive, 0, 'and nothing measurable is on the table')
})

test('a real nought still counts as one', () => {
  const zero = p('Benched Kicker', 'RB', 0, true)
  const out = advise(STEWARD, [
    ...squad.filter((c) => c.name !== 'Mike Washington Jr.' && c.name !== 'Rhamondre Stevenson'),
    zero, p('Nate Landman', 'RB', 14.21, false),
  ])
  const swap = out.swaps.find((s) => s.in.name === 'Nate Landman')!
  assert.equal(swap.unknownOut ?? false, false)
  assert.equal(Number(swap.gain.toFixed(2)), 14.21, 'measured against a man projected to score nothing')
  assert.ok(out.decisive > 14, 'which is genuinely on the table')
})

test('a cascade charges the man who actually leaves, not nothing', () => {
  /*
   * A receiver promoted into WR pushes the incumbent receiver to the flex,
   * which drops the back standing there — and a back cannot fill a receiver's
   * slot. Pairing only on eligibility left him unpaired, charged the promotion
   * nothing, and reported a reshuffle as an empty slot being filled: one real
   * lineup came out at "15.0 points on your bench" with five and a half on the
   * table.
   */
  const slots = slotsFor({ WR: 2 }, [{ name: 'W/R/T', eligible: ['RB', 'WR', 'TE'], count: 1 }])
  const p = (id: string, pos: string, projected: number, starter: boolean) =>
    ({ id, name: id, pos, projected, starter, injuryStatus: null })
  const squad = [
    p('WR_A', 'WR', 13.53, true), p('WR_B', 'WR', 10.71, true),
    p('RB_FLEX', 'RB', 9.11, true),
    p('WR_BENCH', 'WR', 12.53, false),
  ]
  const a = advise(slots, squad)
  assert.ok(a.swaps.every((s) => s.out != null), 'somebody always leaves a full lineup')
  assert.equal(a.swaps[0].out!.id, 'RB_FLEX', 'the man who actually drops out')
  assert.ok(Math.abs(a.gain - (a.optimal - a.current)) < 1e-9)
  assert.ok(a.decisive <= a.gain + 1e-9,
    `what is decisive cannot exceed what is on the table (${a.decisive} vs ${a.gain})`)
  assert.ok(Math.abs(a.gain - 3.42) < 0.01, `13.53+12.53+10.71 against 13.53+10.71+9.11 (got ${a.gain})`)
})
