import type { Alert } from './alerts.js'
import { kickoffAt } from './lock.js'
import { cannotPlay } from './lineup.js'

/**
 * Which facts are worth interrupting you for.
 *
 * Every rule states a fact, a deadline and a consequence — the standard the
 * settings screen already sets. A rule missing any of the three is a note, not
 * an alert, and belongs in the app where you find it in your own time.
 */

export interface Snapshot {
  leagueId: string
  label: string
  /** When the browser sensor last read this roster. Yahoo leagues only. */
  capturedAt?: number | null
  /** Weeks ahead that cannot be filled, soonest first. */
  byes?: { week: number; away: number; shortfalls: { slot: string }[] }[] | null
  /** The week this is, so a bye can be counted forward from it. */
  week?: number | null
  /** Roles moving on players in this league. */
  roles?: { name: string; pos: string; snapTrend: number | null; targetTrend: number | null
            owned: boolean }[] | null
  /** Where the head to head stands, and where it stood last time we looked. */
  matchup?: { mine: number; theirs: number; wasAhead: boolean | null } | null
  /** The draft, while it is still ahead. Null once it has happened. */
  draft?: { at: number; slotSet: boolean; mySlot: number | null } | null
  /** Waivers, where the league reports them. Null where it does not. */
  waivers?: {
    clearsAt: number | null
    assumedDay: string | null
    budget: number | null
    spent: number | null
    holes: { slot: string; reason: string; severity: number }[]
    targets: { name: string; pos: string | null; fills: string; projected: number | null }[]
  } | null
  /** Opens the league in its own app on iOS, via universal links. */
  link: string | null
  players: {
    id: string; name: string; pos: string | null; starter: boolean
    injuryStatus: string | null; projected: number | null; kickoff: string | null
    /**
     * His kickoff from the schedule, in ms — preferred to `kickoff`, the text
     * Yahoo printed. That text was captured once and kept: on the Wednesday of
     * week two it still read "Thu 5:35 pm" for three Rams and a 49er, week
     * one's game, so a linebacker who plays on Monday night was given a
     * Thursday deadline. And Sleeper prints no kickoff at all, so every rule
     * that waits for lock never once reached a Sleeper league as an alert.
     */
    kickoffAt?: number | null
    /** Where his club's game stands. Once it starts, no lineup move exists. */
    game?: 'pre' | 'playing' | 'done' | null
  }[]
  advice: {
    gain: number
    /** The part of the gain that is neither inside the noise nor against a blank. */
    decisive?: number
    swaps: {
      in: { name: string; projected?: number | null }
      out: { name: string } | null
      slot: string
      gain: number
      /** Nobody read the outgoing man's projection, so there is no gain to claim. */
      unknownOut?: boolean
    }[]
  } | null
}

/**
 * A span in the unit a person would use for it. The alert fires half an hour
 * out, where minutes are right; the same rule shown on a screen two days early
 * said "2827 minutes", which is nobody's way of saying two days.
 */
function inWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} hours`
  const d = Math.floor(h / 24)
  const rem = h % 24
  return rem ? `${d}d ${rem}h` : `${d} days`
}

/** Three hours: close enough to lock that a questionable tag has become news. */
const NEAR_LOCK = 3 * 60 * 60 * 1000

/**
 * Two thresholds, one set of rules.
 *
 * A timing gate exists to stop a notification arriving on Wednesday about a
 * kickoff on Sunday. It has no business deciding what the league screen shows
 * once you have opened it and are looking — the same distinction already drawn
 * for the alert budget: ration the interruption, never the information.
 *
 * `display` drops the gates and keeps the rules. What gets pushed stays gated.
 */
/**
 * Rules that are planning rather than today.
 *
 * The home screen answers one question — what needs you now — and counts the
 * leagues that do. A bye eleven days out does not: it is a thing to carry into
 * the next waiver run, not a reason to mark a league this evening, and marking
 * one for it makes "three things in two leagues" mean less every time it is
 * true of something you cannot act on yet.
 *
 * They still belong on the league's own screen, where you have gone to look,
 * and they still earn a notification when their deadline is close — only the
 * tile stays quiet.
 */
export const PLANNING: ReadonlySet<string> = new Set(['bye-ahead'])

export function evaluate(
  s: Snapshot,
  now = Date.now(),
  opts: { display?: boolean } = {},
): Alert[] {
  const out: Alert[] = []

  /*
   * A draft about to start.
   *
   * Half an hour is not an arbitrary reminder: Yahoo publishes the draft order
   * roughly then, so it is the first moment the slot can be known and the board
   * can be opened against it. Missing a draft cannot be undone — the room
   * autodrafts a team you did not choose and you live with it until December —
   * so this is never rationed.
   */
  if (s.draft) {
    const until = s.draft.at - now
    const HALF_HOUR = 30 * 60 * 1000
    if (until > 0 && (until <= HALF_HOUR || opts.display)) {
      out.push({
        id: `${s.leagueId}:draft:${Math.floor(s.draft.at / 60000)}`,
        leagueId: s.leagueId,
        rule: 'draft-imminent',
        headline: `${s.label} drafts in ${inWords(until)}`,
        /*
         * The time is left to the reader's own clock. The callout already
         * prints the deadline, and for this rule the deadline is the draft —
         * so a detail that also named it said the same thing twice.
         */
        detail: s.draft.slotSet
          ? `You pick from slot ${s.draft.mySlot}. Open the board.`
          : 'Yahoo publishes the order about 30 minutes before',
        // A draft you miss is a season you do not get back.
        consequence: 95,
        deadline: s.draft.at,
        link: s.link,
      })
    }
  }
  const starters = s.players.filter((p) => p.starter)
  const lockOf = (p: Snapshot['players'][0]) =>
    p.kickoffAt ?? (p.kickoff ? kickoffAt(p.kickoff, new Date(now)) : null)
  /*
   * The next lock among the starters. Future kickoffs only: a schedule time is
   * a date, and last Thursday's game is not a lock still coming — the printed
   * text never had that problem, since it is always read forward.
   */
  const soonest = () => {
    const times = starters.map(lockOf).filter((t): t is number => t != null && t > now)
    return times.length ? Math.min(...times) : null
  }

  /*
   * A starter who cannot play is the one alert that is never rationed: the slot
   * scores nothing, the fix is free, and it is the single most expensive thing
   * to find out about on Monday.
   */
  for (const p of starters) {
    if (!cannotPlay(p.injuryStatus)) continue
    /*
     * Only while there is still something to do about it. The justification
     * above is that the fix is free — and at kickoff it stops being free,
     * because the slot is locked and no move exists.
     *
     * This is not hypothetical: a receiver carrying a stale designation played
     * on the Thursday and scored, and the rule would have woken you on the
     * Sunday to say he was in your lineup and would not play. Wrong twice
     * over, and at consequence ninety.
     */
    if (p.game === 'playing' || p.game === 'done') continue
    const lock = lockOf(p)
    out.push({
      id: `${s.leagueId}:out:${p.id}:${p.injuryStatus}`,
      leagueId: s.leagueId,
      rule: 'starter-out',
      headline: `${p.name} is ${(p.injuryStatus ?? 'out').toLowerCase()} — ${s.label}`,
      detail: `He is in your lineup and will not play${
        p.projected ? `, where you had ${p.projected.toFixed(1)} projected` : ''}.`,
      consequence: 90,
      deadline: lock,
      link: s.link,
    })
  }

  /*
   * Points left on the bench, but only once close enough to lock that it is
   * worth acting on — and never for a rounding difference. Scaled by the gap,
   * because a point is not worth a notification and eight are.
   */
  /*
   * Only what can actually be measured. A swap whose other half was never read
   * counts its replacement's whole projection as gain, and this announced
   * "14.2 points on your bench" for a choice between a projected linebacker
   * and a blank. That is worth saying — as a question rather than a number.
   */
  const measurable = s.advice ? s.advice.decisive ?? s.advice.gain : 0
  const blind = s.advice?.swaps.find((x) => x.unknownOut) ?? null
  if (s.advice && (measurable >= 3 || blind)) {
    const lock = soonest()
    const near = lock != null && lock - now < 24 * 60 * 60 * 1000
    if (near || opts.display) {
      const best = measurable >= 3 ? s.advice.swaps.find((x) => !x.unknownOut) ?? s.advice.swaps[0] : blind!
      out.push({
        /*
         * Keyed on the move, not the size of it. Rounding the gain into the id
         * meant a projection drifting from 8.4 to 8.6 minted a new identity and
         * pushed the same advice twice, out of a budget of twenty a week.
         */
        id: `${s.leagueId}:lineup:${best?.in.name ?? ''}:${best?.out?.name ?? ''}`,
        leagueId: s.leagueId,
        rule: 'lineup-gain',
        headline: measurable >= 3
          ? `${measurable.toFixed(1)} points on your bench — ${s.label}`
          : `A start/sit worth checking — ${s.label}`,
        detail: measurable < 3 && best
          ? `${best.in.name} projects ${best.in.projected?.toFixed(1) ?? 'more'}` +
            `${best.out ? ` and no projection was read for ${best.out.name}` : ''}, so nothing can compare them at ${best.slot}.`
          : best
            ? `Start ${best.in.name}${best.out ? ` over ${best.out.name}` : ''} at ${best.slot}.`
            : 'Your bench outprojects your lineup.',
        // A big gap is worth more than a small one, but this never outranks a
        // ruled-out starter: it is an improvement, not a hole. A blank is a
        // question, and sits below any measured gain worth acting on.
        consequence: measurable >= 3 ? Math.min(70, 40 + measurable * 2) : 42,
        deadline: lock,
        link: s.link,
      })
    }
  }

  /*
   * Questionable is not news on Wednesday — it is news three hours before
   * kickoff, when the beat reporters have filed and you can still act.
   */
  for (const p of starters) {
    if (!p.injuryStatus || cannotPlay(p.injuryStatus)) continue
    if (!/^(Q|QUESTIONABLE|D|DOUBTFUL)$/i.test(p.injuryStatus.trim())) continue
    // Same reason: "worth a look nearer kickoff" is not advice after kickoff.
    if (p.game === 'playing' || p.game === 'done') continue
    const lock = lockOf(p)
    const nearLock = lock != null && lock - now <= NEAR_LOCK
    if (!nearLock && !opts.display) continue
    out.push({
      id: `${s.leagueId}:q:${p.id}:${lock ? Math.floor(lock / 3600000) : 'x'}`,
      leagueId: s.leagueId,
      rule: 'starter-questionable',
      playerId: p.id,
      headline: `${p.name} is ${p.injuryStatus.toLowerCase()} — ${s.label}`,
      detail: nearLock
        ? 'Kickoff is in under three hours and he is in your lineup.'
        : 'He is in your lineup. Worth a look nearer kickoff.',
      // Only worth waking you for once you can act on it and not before.
      consequence: nearLock ? 50 : 20,
      deadline: lock,
      link: s.link,
    })
  }

  /*
   * Waivers only interrupt you when all three are true: money left, a hole to
   * fix, and somebody available to fix it. A deadline on its own is a calendar
   * reminder, and the calendar already has one.
   */
  const w = s.waivers
  if (w?.clearsAt && w.holes.length && w.targets.length) {
    const left = (w.budget ?? 0) - (w.spent ?? 0)
    const SIX_HOURS = 6 * 60 * 60 * 1000
    const closing = w.clearsAt - now
    if (left > 0 && closing > 0 && (closing < SIX_HOURS || opts.display)) {
      const hole = w.holes[0]
      const pick = w.targets[0]
      /*
       * When they actually close.
       *
       * This said "tonight" whatever the clock held. The six-hour gate is on
       * the notification; the screens ask for it ungated so the money and the
       * hole are visible all week, and on those it was announcing a deadline
       * six days out as though it were this evening. Said in the reader's own
       * terms — tonight, tomorrow, or the day by name.
       */
      const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const when = closing < 12 * 3600_000 ? 'tonight'
        : closing < 36 * 3600_000 ? 'tomorrow'
        : `on ${DAYS[new Date(w.clearsAt).getDay()]}`
      out.push({
        id: `${s.leagueId}:waiver:${Math.floor(w.clearsAt / 86400000)}:${hole.slot}`,
        leagueId: s.leagueId,
        rule: 'waivers-closing',
        headline: `Waivers close ${when} with $${left} unspent — ${s.label}`,
        detail: `${hole.slot}: ${hole.reason}. ${pick.name} is available${
          pick.projected ? ` and projects ${pick.projected.toFixed(1)}` : ''}.`,
        // Real money and a real hole, but recoverable next week — so it is
        // rationed, unlike a starter who cannot play.
        consequence: Math.min(75, 40 + hole.severity / 3),
        deadline: w.clearsAt,
        link: s.link,
      })
    }
  }

  /*
   * A roster nobody has read for days.
   *
   * The Yahoo leagues only update when a page is opened, so a stale capture
   * does not merely age — every piece of advice built on it is wrong in a way
   * that looks right. Worth saying before the games, not after.
   */
  if (s.capturedAt) {
    const age = now - s.capturedAt
    const lock = soonest()
    const closing = lock != null && lock - now < 24 * 60 * 60 * 1000
    if (age > 2 * 24 * 60 * 60 * 1000 && (closing || opts.display)) {
      out.push({
        id: `${s.leagueId}:stale:${Math.floor(now / 86400000)}`,
        leagueId: s.leagueId,
        rule: 'roster-stale',
        headline: `${s.label} has not been read for ${Math.round(age / 86400000)} days`,
        detail: 'Open your Yahoo team once — everything this weekend is built on that roster.',
        // Recoverable in seconds, and it poisons everything else if ignored.
        consequence: 60,
        deadline: lock,
        link: s.link,
      })
    }
  }

  /*
   * A bye you cannot cover, while there is still somebody to claim.
   *
   * During the week itself the alert is worth nothing: everyone has had the
   * same idea and the replacements are gone. It fires a week out, when waivers
   * still have depth.
   */
  if (s.byes?.length && s.week != null) {
    const soon = s.byes.find(
      (b) => b.shortfalls.length && b.week - s.week! === 1,
    )
    if (soon && (s.waivers?.clearsAt || opts.display)) {
      out.push({
        id: `${s.leagueId}:bye:${soon.week}`,
        leagueId: s.leagueId,
        rule: 'bye-ahead',
        headline: `Week ${soon.week} leaves you short at ${soon.shortfalls.map((x) => x.slot).join(', ')} — ${s.label}`,
        detail: `${soon.away} away that week. Claim now, while there is still somebody to claim.`,
        consequence: 55,
        deadline: s.waivers?.clearsAt ?? null,
        link: s.link,
      })
    }
  }

  /*
   * A role changing, which moves days before the points do. That is the whole
   * reason to watch it — by the time production follows, the wire has gone.
   */
  for (const r of s.roles ?? []) {
    const snap = r.snapTrend ?? 0
    const targ = r.targetTrend ?? 0
    if (snap < 0.15 && targ < 0.06) continue
    out.push({
      id: `${s.leagueId}:role:${r.name}:${Math.round(snap * 20)}`,
      leagueId: s.leagueId,
      rule: 'role-changing',
      headline: `${r.name} is playing more — ${s.label}`,
      detail: [
        snap ? `snaps ${snap > 0 ? '+' : ''}${Math.round(snap * 100)}%` : '',
        targ ? `targets ${targ > 0 ? '+' : ''}${(targ * 100).toFixed(1)}%` : '',
        r.owned ? 'and he is yours' : 'and he is free here',
      ].filter(Boolean).join(' · '),
      // Worth knowing, never worth waking up for.
      consequence: r.owned ? 40 : 30,
      deadline: s.waivers?.clearsAt ?? null,
      link: s.link,
    })
  }

  /*
   * The week turning against you, once. A margin that wobbles all afternoon is
   * noise; crossing from ahead to behind is the moment the lineup matters.
   */
  if (s.matchup && s.matchup.wasAhead === true && s.matchup.mine < s.matchup.theirs) {
    const lock = soonest()
    out.push({
      id: `${s.leagueId}:flip:${Math.floor(now / 3600000)}`,
      leagueId: s.leagueId,
      rule: 'matchup-flipped',
      headline: `You are behind in ${s.label}`,
      detail: `${s.matchup.mine.toFixed(1)} to ${s.matchup.theirs.toFixed(1)} — you were ahead at the last look.`,
      consequence: 50,
      deadline: lock,
      link: s.link,
    })
  }

  return out
}
