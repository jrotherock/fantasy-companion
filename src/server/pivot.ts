/**
 * What to do about a questionable starter before you know whether he plays.
 *
 * Clubs name their inactives ninety minutes before kickoff, and that is when
 * a questionable player stops being a question. Whether you can still act on
 * the answer depends on who is left: a replacement whose game has already
 * started cannot be brought in. Ladd McConkey plays at 4:05 on a Sunday, so
 * his status is known at 2:35 — after every one-o'clock game has locked.
 *
 * So the plan is one of four, and none of it is a medical opinion:
 *
 *   covered       someone at his position is still unlocked when the news comes
 *   use-flex      only flex-eligible players are, and he can sit in the flex —
 *                 so if he is out, any of them can take his place from there
 *   decide-early  every replacement has locked by then; decide before the last
 *                 one kicks off
 *   no-cover      nobody on the bench could replace him at all
 *
 * Where the platform states which slot each starter is in — Sleeper always,
 * Yahoo once the API has read the league — the question is asked of his own
 * slot: who could fill it, and where nobody on the bench can, which
 * rearrangement would, and by when. A back is no cover for a receiver's slot
 * at any hour, and treating his position as his place named three of them.
 *
 * Where it is not stated — a Yahoo league the API has not reached, read by the
 * sensor, which sees who starts and not where — "can he sit in the flex" is
 * asked of the lineup as a whole instead: with him in the flex, can everyone
 * else still be placed?
 */
import { cannotPlay, type Slot } from './lineup.js'

/** Inactives are named this long before kickoff. */
export const INACTIVES_BEFORE = 90 * 60_000

export interface PivotMan {
  id: string
  name: string
  pos: string | null
  /**
   * The slot he is in now, where the platform states it. Sleeper does — its
   * starters are in roster-position order — and the Yahoo sensor does not, so
   * everything below has to work either way.
   */
  slot?: string | null
  projected: number | null
  injuryStatus: string | null
  starter: boolean
  /** Kickoff of his game in ms, or null where the schedule does not say. */
  kickoff: number | null
  /**
   * His club is away this week, so he is not cover for anybody. Told
   * explicitly rather than inferred from a missing kickoff, which also means
   * "the schedule could not be read" and would throw away real cover.
   */
  onBye?: boolean | null
}

export interface Cover {
  id: string
  name: string
  pos: string | null
  projected: number | null
  kickoff: number
}

export interface Pivot {
  playerId: string
  name: string
  kickoff: number
  inactivesAt: number
  plan: 'covered' | 'use-flex' | 'decide-early' | 'no-cover'
  /** At his position, still unlocked when his status is known. */
  direct: Cover[]
  /** Able to replace him only from a flex, still unlocked then. */
  viaFlex: Cover[]
  /** The flex he can be moved into with the rest of the lineup still legal. */
  flex: string | null
  /**
   * For use-flex: the move has to be made before anyone it might shift has
   * kicked off, since a locked player cannot change slots.
   */
  moveBy: number | null
  /** For decide-early: when the last available replacement locks. */
  decideBy: number | null
  /**
   * Where nothing on the bench can fill his slot but the lineup can still be
   * rearranged: somebody already starting moves up into it, and a bench man
   * takes the slot he leaves.
   *
   * It has its own deadline, and an earlier one than anything else here: a man
   * whose game has begun cannot change slots, so the move has to be made
   * before the first of the two kicks off — which for a Monday-night receiver
   * covered by the Sunday flex means Sunday morning, not Monday afternoon.
   * Making it benches him, so it is a decision rather than a contingency.
   */
  shuffle?: {
    /** The starter who moves up into his slot. */
    up: Cover
    from: string
    /** The bench man who takes the slot that leaves. */
    in: Cover
    to: string
    by: number
  } | null
  /** What he projects, so a replacement can be weighed against him. */
  projected: number | null
  /**
   * Who the decision is actually between, best first.
   *
   * The plan used to say when to decide and never who by — it worked out the
   * candidates to find the deadline and then dropped them, leaving "decide by
   * one o'clock" with nothing to decide about.
   */
  decideAmong: Cover[]
  /**
   * A free agent who projects better than anyone on the bench, where the wire
   * can be seen at all — Sleeper's, and Yahoo's once the API has read every
   * roster. `onWaivers` marks a man dropped inside the waiver period, who is
   * claimed overnight rather than added now.
   */
  pickup?: (Cover & { onWaivers?: boolean }) | null
  /**
   * A free agent whose own game starts after this man's status is known, for
   * the weeks where nobody on the bench does.
   *
   * Worth naming even when he projects below the bench, which is why the
   * pickup above cannot find him: with a questionable receiver playing on
   * Monday and three running backs who all kick off on Sunday, the plan was
   * "decide blind by twenty past one" — and a five-point receiver in his own
   * Monday game turns that into a decision made at a quarter to four with the
   * inactives in hand. The points are not the point; the clock is.
   */
  keepsOpen?: (Cover & { onWaivers?: boolean }) | null
  /**
   * Another questionable starter who plays the same position, where the bench
   * has nobody of it. Each is covered on his own and both together are not:
   * one slot would score nothing, and no single plan says so.
   */
  alsoDoubtful?: { id: string; name: string; pos: string | null }[]
}

const QUESTIONABLE = /^(Q|QUESTIONABLE)$/i
const fits = (slot: Slot, pos: string | null) =>
  !!pos && slot.eligible.some((e) => e.toUpperCase() === pos.toUpperCase())
const unlockedAt = (m: PivotMan, t: number) => m.kickoff == null || m.kickoff > t
const cover = (m: PivotMan): Cover => ({
  id: m.id, name: m.name, pos: m.pos, projected: m.projected, kickoff: m.kickoff ?? Number.POSITIVE_INFINITY,
})
const byProjection = (a: PivotMan, b: PivotMan) => (b.projected ?? 0) - (a.projected ?? 0)

/**
 * Whether every other starter can still be placed with `him` in `flex`.
 *
 * Narrowest slot first, as the optimiser fills a lineup: a dedicated slot
 * takes the one position it accepts, and what is left goes to the flexes.
 * A starter whose game has begun is fixed where he is, and since where that
 * is cannot be seen, a rearrangement that might need to move him is refused
 * rather than guessed at.
 */
function canSitIn(flex: number, him: PivotMan, slots: Slot[], starters: PivotMan[], now: number): boolean {
  const others = starters.filter((s) => s.id !== him.id)
  if (others.some((o) => fits(slots[flex], o.pos) && !unlockedAt(o, now))) return false
  const open = slots.map((s, i) => ({ s, i })).filter(({ i }) => i !== flex)
    .sort((a, b) => a.s.eligible.length - b.s.eligible.length)
  const placed = new Set<string>()
  for (const { s } of open) {
    const pick = others.find((o) => !placed.has(o.id) && fits(s, o.pos))
    if (pick) placed.add(pick.id)
  }
  return placed.size === others.length
}

export function pivotPlans(slots: Slot[], squad: PivotMan[], now: number): Pivot[] {
  const starters = squad.filter((m) => m.starter)
  // Nor a man on his bye: he cannot cover a doubtful starter either.
  const bench = squad.filter((m) => !m.starter && !cannotPlay(m.injuryStatus) && !m.onBye)
  const out: Pivot[] = []

  for (const him of starters) {
    if (!him.injuryStatus || !QUESTIONABLE.test(him.injuryStatus.trim())) continue
    // Once his game has begun there is no plan left to make.
    if (him.kickoff == null || him.kickoff <= now) continue
    const inactivesAt = him.kickoff - INACTIVES_BEFORE

    const flexes = slots.map((s, i) => ({ s, i }))
      .filter(({ s }) => s.eligible.length > 1 && fits(s, him.pos))
    /*
     * Moving him into a flex is only a plan where nobody knows which slot he
     * is in. Where the platform states it, he is either in one already or he
     * is in a dedicated slot, and then the lineup is rearranged around him
     * rather than him around it.
     */
    const usable = him.slot
      ? null
      : flexes.find(({ i }) => canSitIn(i, him, slots, starters, now)) ?? null

    /*
     * His own slot, where the platform says which one it is.
     *
     * It decides who can replace him at all: three running backs on the bench
     * are cover for a flex and no cover whatever for a receiver's slot, and
     * without this the plan named them anyway — and gave a deadline three
     * hours later than the real one.
     */
    const hisSlot = him.slot ? slots.find((x) => x.name === him.slot) : null
    const dedicated = hisSlot && hisSlot.eligible.length === 1
    const samePos = bench.filter((b) =>
      hisSlot ? fits(hisSlot, b.pos) : !!b.pos && !!him.pos && b.pos.toUpperCase() === him.pos.toUpperCase())
    const flexOnly = usable
      ? bench.filter((b) => !samePos.includes(b) && fits(usable.s, b.pos))
      : []

    const direct = samePos.filter((b) => unlockedAt(b, inactivesAt)).sort(byProjection)
    const viaFlex = flexOnly.filter((b) => unlockedAt(b, inactivesAt)).sort(byProjection)

    let plan: Pivot['plan']
    let decideBy: number | null = null
    // Everyone who could replace him and has not kicked off yet.
    const stillOpen = [...samePos, ...flexOnly].filter((b) => unlockedAt(b, now) && b.kickoff != null)
    if (direct.length) plan = 'covered'
    else if (viaFlex.length) plan = 'use-flex'
    else if (stillOpen.length) {
      // All of them lock before his news: the last to kick off is the last
      // moment the decision can still be made.
      plan = 'decide-early'
      decideBy = Math.max(...stillOpen.map((b) => b.kickoff!))
    } else plan = 'no-cover'

    /*
     * Where nothing on the bench fits his slot: somebody starting elsewhere
     * who could fill it moves up, and a bench man takes the slot he leaves.
     * Both of them have to be unlocked when the move is made, so the deadline
     * is the earlier of their two kickoffs.
     */
    let shuffle: Pivot['shuffle'] = null
    if (dedicated && !direct.length) {
      const options = []
      for (const s of starters) {
        if (s.id === him.id || !fits(hisSlot!, s.pos) || !s.slot) continue
        const theirs = slots.find((x) => x.name === s.slot)
        if (!theirs || theirs.name === hisSlot!.name) continue
        for (const b of bench) {
          if (!fits(theirs, b.pos)) continue
          const by = Math.min(s.kickoff ?? Number.POSITIVE_INFINITY, b.kickoff ?? Number.POSITIVE_INFINITY)
          if (by <= now) continue
          options.push({ up: cover(s), from: s.slot!, in: cover(b), to: theirs.name, by })
        }
      }
      // The most points coming off the bench, and the latest door among those.
      shuffle = options.sort((a, b) => (b.in.projected ?? 0) - (a.in.projected ?? 0) || b.by - a.by)[0] ?? null
    }

    const moveBy = plan === 'use-flex' && usable
      ? Math.min(him.kickoff, ...starters
          .filter((o) => o.id !== him.id && o.kickoff != null && fits(usable.s, o.pos))
          .map((o) => o.kickoff!))
      : null

    /*
     * The other questionable starters at his position, where the bench holds
     * nobody who plays it. Each man's own plan can be sound while the pair of
     * them empties a slot, and nothing else on the page asks that question.
     */
    const others = samePos.length ? [] : starters
      .filter((o) => o.id !== him.id && o.pos && him.pos &&
        o.pos.toUpperCase() === him.pos.toUpperCase() &&
        !!o.injuryStatus && QUESTIONABLE.test(o.injuryStatus.trim()))
    /*
     * Said once, on the decision that comes first. Both men's plans sit in one
     * box on the page, and the same warning under each read as two problems
     * rather than one — and the earlier kickoff is where it can still be acted
     * on, since that is the roster move that has to happen first.
     */
    const mine = him.kickoff
    const first = others.every((o) => (o.kickoff ?? Infinity) >= mine)
    const alsoDoubtful = first ? others.map((o) => ({ id: o.id, name: o.name, pos: o.pos })) : []

    out.push({
      playerId: him.id, name: him.name, kickoff: him.kickoff, inactivesAt, plan,
      ...(alsoDoubtful.length ? { alsoDoubtful } : {}),
      direct: direct.slice(0, 3).map(cover),
      viaFlex: viaFlex.slice(0, 3).map(cover),
      flex: plan === 'use-flex' && usable ? usable.s.name : null,
      moveBy,
      decideBy,
      ...(shuffle ? { shuffle } : {}),
      projected: him.projected,
      decideAmong: [...stillOpen].sort(byProjection).slice(0, 3).map(cover),
    })
  }
  return out
}
