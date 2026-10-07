/**
 * What to start, and what it costs you not to.
 *
 * Every number needed for this was already on screen — projections for the
 * starters, projections for the bench, the league's own slot shape — and the
 * app said nothing. Showing two columns and leaving the arithmetic to the
 * reader is not advice.
 */

export interface Slot {
  name: string
  /** Positions this slot accepts. A dedicated slot accepts exactly one. */
  eligible: string[]
}

export interface Candidate {
  id: string
  name: string
  pos: string | null
  projected: number | null
  injuryStatus: string | null
  /** Whether the manager currently has them in the lineup. */
  starter: boolean
  /**
   * This week's expert consensus rank within his position, lower being better.
   * Consulted only between two players the projections cannot separate.
   */
  weekRank?: number | null
  /**
   * How the defence he faces treats his position: 1 is the most generous in
   * the league, higher is meaner. Consulted after the consensus, and for the
   * same reason — it orders players the projection has already tied.
   */
  dvpRank?: number | null
  /**
   * His share of his own team's targets and carries, averaged over the last few
   * weeks. Consulted only between players the projection cannot separate — a
   * projection already prices in expected volume, so using this as a number to
   * add would count the same fact twice.
   */
  role?: number | null
  /** Whether that share is of the ball or of his club's defensive snaps. */
  roleOf?: 'touches' | 'snaps' | null
  /**
   * His game has begun, so no move can reach him: a starter cannot be taken
   * out and a bench player cannot be brought in.
   *
   * Without this the board went on proposing swaps for a receiver who had
   * already played — reading as an oversight you could still fix, and in fact
   * arithmetic about a decision that closed at kickoff. It bit hardest on a
   * man carrying a stale designation: ruled out on paper, worth nought to the
   * optimiser, and eleven points of imaginary gain sitting on the card while
   * he had in truth taken the field and scored.
   */
  locked?: boolean
}

export interface Swap {
  in: Candidate
  out: Candidate | null
  slot: string
  /** Points gained by making this one change. */
  gain: number
  reason: 'points' | 'out' | 'empty'
  /** Inside the noise: a difference the projections cannot actually see. */
  close: boolean
  /**
   * The man coming out has no projection at all, so there is no gain to
   * report — only a decision to make.
   *
   * An unread projection was valued at nought like everything else, which made
   * the man replacing him look worth his whole projection: "+14.2 on the
   * table" for a swap whose other half was simply unknown. Yahoo prints a
   * player's projection right up until his game is over, and the sensor reads
   * sixteen of seventeen on a good day; the seventeenth is a gap, not a zero.
   */
  unknownOut?: boolean
}

/**
 * Below this, two players are the same player this week.
 *
 * A weekly projection is not precise to a tenth. Presenting "+0.6 on the
 * table" in the same voice as "+6.0" invites a lineup change on a difference
 * the model cannot resolve — and the two flex calls this was written for,
 * Rhamondre Stevenson at 9.3 against a 10.2 flex and Parker Washington at 9.5
 * against a 10.1, are both well inside it.
 *
 * Provisional, and deliberately a round number rather than a false precision:
 * the season review measures the calls against what the bench actually did,
 * and this should be set from that once there are weeks to measure.
 */
export const COIN_FLIP = 1.5

/*
 * How far apart two men can be projected and still be worth a second look.
 *
 * Measured on 90,756 startable same-position pairs from 2024 and 2025, half-PPR
 * projections against what was actually scored: inside three points the
 * lower-projected man still outscores the higher one between 38 and 49 per
 * cent of the time, so a three-point edge is right about three times in five.
 * The curve is shallow everywhere — even six to eight points apart the
 * underdog takes a quarter of them — so this is a line drawn across a slope,
 * not at a cliff.
 *
 * Position barely moves it and does not move it consistently. The gap where
 * the flip rate falls under 40% is 3.25 for quarterbacks, 2.25 for receivers,
 * 2.0 for running backs and 1.5 for tight ends; measured instead as a share of
 * what the two men project the order inverts, 13% for quarterbacks against 21%
 * for tight ends. Neither framing collapses the positions — average
 * disagreement 7.9 points of flip rate absolute against 6.7 proportional — so
 * one number it is, and the one position it under-flags is quarterbacks, which
 * is the safe direction.
 *
 * Inside COIN_FLIP the projection has said nothing and a tiebreak decides.
 * Between the two it has an opinion, and it takes other signals disagreeing
 * with it to reopen the question.
 */
export const SPLIT_BAND = 3

/*
 * Defenders need a wider one. The same measurement over 64,674 startable IDP
 * pairs, scored under this league's own settings, puts the 40% crossing at
 * 3.5 — 3.25 for linebackers, 4.5 for backs, 2.75 for linemen — against 2.0
 * to 2.25 for running backs and receivers. A weekly IDP projection simply
 * knows less: at four to five points apart the lower-projected defender still
 * takes 39% of them.
 */
export const IDP_SPLIT_BAND = 4
const IDP = new Set(['DB', 'DL', 'LB'])
export const splitBand = (pos: string | null | undefined) =>
  IDP.has(String(pos ?? '').toUpperCase()) ? IDP_SPLIT_BAND : SPLIT_BAND

/**
 * How much bigger one man's role must be before it decides anything.
 *
 * Five points of his team's opportunities. Measured on 2025 under this
 * league's scoring: among pairs the projection called level, the larger role
 * won about 62 per cent of the time with any gap at all, 65 to 68 at five
 * points, and 67 to 70 at eight. The curve rises steadily with the gap, which
 * is what a real signal does and what noise does not — but the gaps above five
 * points are rare, and a tiebreak that almost never speaks is not worth having.
 *
 * Five is where it is both right about two times in three and still says
 * something most weeks.
 */
export const ROLE_GAP = 0.05

/*
 * A defender's role is a share of snaps rather than of the ball, and it takes
 * a wider gap to mean anything. Measured over 54,409 startable IDP pairs from
 * 2024 and 2025 that a projection put within four points: the bigger recent
 * snap share won 63% of them once the gap reached ten points, and 52% or less
 * below it, which is nothing.
 */
export const IDP_ROLE_GAP = 0.10
export const roleGapFor = (kind: 'touches' | 'snaps' | null | undefined) =>
  kind === 'snaps' ? IDP_ROLE_GAP : ROLE_GAP

/**
 * A decision the projections could not make, whichever way it fell.
 *
 * A close call that resolves in favour of the man already starting produces no
 * swap, so reporting only swaps hid exactly the calls worth thinking about —
 * the board said "your lineup is the best you can field" and never mentioned
 * that two of the slots were coin flips.
 */
export interface CloseCall {
  slot: string
  /** Who the optimiser would start. */
  keep: Candidate
  /** The nearest player it could have started instead. */
  alternative: Candidate
  /** Projected points between them, always positive. */
  gap: number
  /** What decided it, once the projection had given up. */
  by: 'consensus' | 'role' | 'matchup' | 'projection' | 'nothing'
  /**
   * Inside the coin flip, where the projection has said nothing at all. Outside
   * it and inside SPLIT_BAND the projection does have an opinion, and the call
   * is only worth showing if other signals contradict it.
   */
  tight: boolean
}

/**
 * A player who cannot take the field scores nothing, whatever the projection
 * still says. Sites are slow to zero these out, and a stale number in the
 * lineup optimiser would quietly recommend starting someone on IR.
 *
 * Doubtful belongs here and did not. It was grouped with Questionable as
 * something to flag rather than adjust, on the reasoning that discounting a
 * designation by a guessed multiplier is invented precision — which is right
 * about Questionable and wrong about this one. Doubtful is not a probability
 * to be shaded, it is a near-certainty in the other direction, and the news
 * feed has always treated it as out. So the two halves of the app disagreed:
 * Brock Bowers was reported doubtful with a meniscus and a surgery note in one
 * tab while the optimiser had him starting for 11.5 points in another.
 *
 * Questionable stays at face value. Fifty-nine ranked players carry one in
 * August, and zeroing those would empty the board.
 */
const CANNOT_PLAY = /^(OUT|DOUBTFUL|DTD-OUT|IR|SUS|SUSP|PUP|NA|DNR|COV|NFI)$/i

export const cannotPlay = (s: string | null | undefined) => !!s && CANNOT_PLAY.test(s.trim())

const value = (c: Candidate) => (cannotPlay(c.injuryStatus) ? 0 : (c.projected ?? 0))

/** Expand a league's slot counts into the individual slots of a lineup. */
export function slotsFor(
  starters: Record<string, number>,
  flex: { name: string; eligible: string[]; count: number }[],
): Slot[] {
  const out: Slot[] = []
  for (const [pos, n] of Object.entries(starters)) {
    for (let i = 0; i < n; i++) out.push({ name: pos, eligible: [pos] })
  }
  for (const f of flex) {
    for (let i = 0; i < f.count; i++) out.push({ name: f.name, eligible: f.eligible })
  }
  return out
}

const eligibleFor = (slot: Slot, c: Candidate) =>
  !!c.pos && slot.eligible.some((e) => e.toUpperCase() === c.pos!.toUpperCase())

/**
 * Projection first, consensus only inside the noise.
 *
 * Half a point of projected difference is not a difference, and picking on it
 * is picking on rounding. Where the model cannot separate two players, this
 * asks a second opinion built by a different process — and where the model
 * *can*, the second opinion is ignored, because these ranks are half-PPR and
 * know nothing of the league's own scoring.
 */
export function better(a: Candidate, b: Candidate): number {
  const d = value(b) - value(a)
  if (Math.abs(d) >= COIN_FLIP) return d
  // The consensus first: it is a whole second opinion rather than one input to
  // one.
  const ra = a.weekRank, rb = b.weekRank
  if (typeof ra === 'number' && typeof rb === 'number' && ra !== rb) return ra - rb
  /*
   * Then the role, ahead of the opponent. What a man's own team did with him
   * is a harder fact than how a defence has treated his position on average,
   * and it measured that way: the role wins about two thirds of these, while
   * the defence's contribution has never been measured at all.
   */
  const oa = a.role, ob = b.role
  if (typeof oa === 'number' && typeof ob === 'number' &&
      Math.abs(oa - ob) >= roleGapFor(a.roleOf ?? b.roleOf)) {
    return ob - oa
  }
  // Then who they are facing. A generous defence ranks 1, so lower is better
  // for the player, which is the opposite of how the rank reads aloud.
  const da = a.dvpRank, db = b.dvpRank
  if (typeof da === 'number' && typeof db === 'number' && da !== db) return da - db
  return d
}

/**
 * Fill the most restrictive slots first with the best player each can take.
 *
 * Fantasy eligibility is laminar — a flex accepts a superset of what the
 * dedicated slots accept — so taking the narrowest slot first is optimal. The
 * repair pass that follows is belt and braces: it retries every reassignment
 * that would raise the total, so a shape that is not laminar cannot quietly
 * produce a worse answer than the manager's own lineup.
 */
export function bestLineup(
  slots: Slot[],
  squad: Candidate[],
  cmp: (a: Candidate, b: Candidate) => number = better,
): Map<number, Candidate> {
  const order = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.eligible.length - b.s.eligible.length)
  const taken = new Set<string>()
  const filled = new Map<number, Candidate>()

  /*
   * Locked starters take their places first and hold them.
   *
   * Narrowest slot each, so a locked quarterback settles into QB rather than
   * a flex he also happens to fit and which somebody else may need.
   */
  const frozen = new Set<number>()
  for (const { s, i } of order) {
    const held = squad.find(
      (c) => c.locked && c.starter && !taken.has(c.id) && eligibleFor(s, c),
    )
    if (held) { filled.set(i, held); taken.add(held.id); frozen.add(i) }
  }
  // Everyone whose game has begun is out of the running, in both directions.
  const movable = squad.filter((c) => !c.locked)

  for (const { s, i } of order) {
    if (frozen.has(i)) continue
    const pick = movable
      .filter((c) => !taken.has(c.id) && eligibleFor(s, c))
      .sort(cmp)[0]
    if (pick) { filled.set(i, pick); taken.add(pick.id) }
  }

  // Repair: any single move that raises the total is applied until none remain.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (let i = 0; i < slots.length; i++) {
      if (frozen.has(i)) continue
      const sitting = filled.get(i)
      for (const c of movable) {
        if (taken.has(c.id) || !eligibleFor(slots[i], c)) continue
        if (sitting ? cmp(c, sitting) >= 0 : value(c) <= 0) continue
        if (sitting) taken.delete(sitting.id)
        filled.set(i, c); taken.add(c.id); moved = true
        break
      }
    }
    if (!moved) break
  }
  return filled
}

/**
 * One entry per rival, keeping the one worth acting on.
 *
 * Keeping merely the tightest gap threw away the only call that needed a
 * decision: the same bench receiver was the nearest rival to three slots, and
 * the closest of those three happened to be one already resolved in favour of
 * the man starting. A call that asks you to move somebody outranks one that
 * does not, however much tighter the second is.
 */
function dedupe(calls: CloseCall[]): CloseCall[] {
  const ranked = [...calls].sort((a, b) => {
    const act = Number(!a.keep.starter) - Number(!b.keep.starter)
    return act !== 0 ? -act : a.gap - b.gap
  })
  const perRival = new Map<string, CloseCall>()
  for (const c of ranked) if (!perRival.has(c.alternative.id)) perRival.set(c.alternative.id, c)
  return [...perRival.values()]
}

/**
 * The changes worth making, largest first — stated as moves rather than as an
 * optimal lineup, because a manager acts one substitution at a time.
 */
export function advise(
  slots: Slot[],
  squad: Candidate[],
): {
  swaps: Swap[]
  gain: number
  optimal: number
  current: number
  /** The part of the gain that is not inside the noise. */
  decisive: number
  /** Slots where two players are effectively the same this week. */
  closeCalls: CloseCall[]
} {
  /*
   * Two passes, because the tiebreak and the headline answer different
   * questions.
   *
   * `best` is what to recommend, and inside the noise it may prefer a player
   * projected a little lower — that is the whole point of a tiebreak. But the
   * number at the top of the card is "what is on the table", and measuring it
   * against a lineup the tiebreak has already nudged produced a *negative*
   * gain: the board reporting that its own advice cost you nine tenths of a
   * point. So the headline is measured against the projection-maximising
   * lineup, which is what "on the table" has always meant.
   */
  const best = bestLineup(slots, squad)
  const byPoints = bestLineup(slots, squad, (a, b) => value(b) - value(a))
  const optimal = [...byPoints.values()].reduce((a, c) => a + value(c), 0)
  const current = squad.filter((c) => c.starter).reduce((a, c) => a + value(c), 0)

  const chosen = new Set([...best.values()].map((c) => c.id))
  const benched = squad.filter((c) => c.starter && !chosen.has(c.id))
  const promoted = [...best.entries()].filter(([, c]) => !c.starter)

  const swaps: Swap[] = []
  for (const [slotIdx, inc] of promoted) {
    // Pair each promotion with the weakest player it displaces that it could
    // actually replace, so the move reads as one the manager can make.
    let outIdx = benched.findIndex((o) => eligibleFor(slots[slotIdx], o))
    /*
     * Failing that, the weakest man who is actually leaving the lineup.
     *
     * A cascade moves people between slots: a receiver promoted into WR pushes
     * the incumbent receiver out to the flex, which drops the back who was
     * standing there — and a back is not eligible for a receiver's slot. The
     * pairing found nobody, charged the promotion nothing, and the reshuffle
     * reported itself as an empty slot being filled. One lineup came out at
     * "15.0 points on your bench" with five and a half actually on the table,
     * the difference being a receiver's whole projection counted as gain.
     */
    if (outIdx < 0 && benched.length) {
      outIdx = benched.reduce((lo, o, i, all) => (value(o) < value(all[lo]) ? i : lo), 0)
    }
    const out = outIdx >= 0 ? benched.splice(outIdx, 1)[0] : null
    // Nothing to measure against: he is not projected at nought, he is unread.
    const unknownOut = !!out && out.projected == null && !cannotPlay(out.injuryStatus)
    swaps.push({
      in: inc,
      out,
      slot: slots[slotIdx].name,
      gain: value(inc) - (out ? value(out) : 0),
      reason: out && cannotPlay(out.injuryStatus) ? 'out' : out ? 'points' : 'empty',
      ...(unknownOut ? { unknownOut } : {}),
      // A player who cannot take the field is never a close call, whatever the
      // arithmetic says about the man replacing him — nor is one nobody can
      // measure, where the arithmetic is against a blank.
      close:
        !unknownOut &&
        !(out && cannotPlay(out.injuryStatus)) &&
        value(inc) - (out ? value(out) : 0) < COIN_FLIP,
    })
  }
  swaps.sort((a, b) => b.gain - a.gain)
  /*
   * What is genuinely on the table. A swap whose other half was never read
   * contributes nothing to it: the number would be his replacement's whole
   * projection, presented as points gained.
   */
  const decisive = swaps.filter((x) => !x.close && !x.unknownOut).reduce((a, x) => a + x.gain, 0)

  /*
   * Every slot where the runner-up is inside the noise, reported whether or not
   * the optimiser wants to change anything. A tie resolved in favour of the
   * incumbent is still a tie, and still the pick most worth a second look.
   */
  const closeCalls: CloseCall[] = []
  const started = new Set([...best.values()].map((c) => c.id))
  for (const [idx, keep] of best) {
    // A choice you can no longer make is not a close call, however tight it
    // was: either side of it having kicked off settles the matter.
    if (keep.locked) continue
    const rival = squad
      .filter((c) =>
        !started.has(c.id) && !c.locked &&
        eligibleFor(slots[idx], c) && !cannotPlay(c.injuryStatus))
      .sort((a, b) => value(b) - value(a))[0]
    if (!rival) continue
    const gap = Math.abs(value(keep) - value(rival))
    if (gap >= splitBand(keep.pos)) continue
    const tight = gap < COIN_FLIP
    const rk = (c: Candidate) => (typeof c.weekRank === 'number' ? c.weekRank : null)
    const dv = (c: Candidate) => (typeof c.dvpRank === 'number' ? c.dvpRank : null)
    const ro = (c: Candidate) => (typeof c.role === 'number' ? c.role : null)
    // Outside the coin flip the projection decided it, whatever else it knows.
    const by: CloseCall['by'] = !tight ? 'projection'
      : rk(keep) != null && rk(rival) != null && rk(keep) !== rk(rival) ? 'consensus'
      : ro(keep) != null && ro(rival) != null &&
        Math.abs(ro(keep)! - ro(rival)!) >= roleGapFor(keep.roleOf ?? rival.roleOf) ? 'role'
      : dv(keep) != null && dv(rival) != null && dv(keep) !== dv(rival) ? 'matchup'
      : gap > 0.05 ? 'projection'
      : 'nothing'
    closeCalls.push({
      slot: slots[idx].name, keep, alternative: rival, gap: Number(gap.toFixed(2)), by, tight,
    })
  }
  closeCalls.sort((a, b) => a.gap - b.gap)
  /*
   * One entry per rival, not one per slot.
   *
   * The best player on the bench is the nearest rival to every slot he is
   * eligible for, so a single receiver produced three identical comparisons —
   * the same two names, the same evidence, three times down the screen. Only
   * the tightest of them is a decision; the rest are the same decision
   * restated.
   */

  // Never negative: the best available lineup cannot score less than the one
  // already set, and a rounding error that says otherwise is worse than silence.
  return {
    swaps, gain: Math.max(0, optimal - current), optimal, current, decisive,
    closeCalls: dedupe(closeCalls),
  }
}
