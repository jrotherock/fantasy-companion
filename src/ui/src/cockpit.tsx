/**
 * Four leagues on one surface.
 *
 * A separate entry from the draft companion on purpose: the companion is used
 * at 10pm beside a live draft, and nothing built here should be able to break
 * it. The two meet at the league card, which is the way into a draft — there is
 * no separate "drafts" destination, because a league is a league whether it is
 * drafting or playing.
 */
import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './cockpit.css'
import { Attribution } from './attribution'
import type { SeasonTile, SeasonView } from '../../nba/seasonView'
import { NbaLeague } from './nba/League'
import { NbaMoves, NbaNews } from './nba/Cross'
import './nba/league.css'

type Urgency = 'act' | 'soon' | 'watch' | 'quiet' | 'blocked'
type Verdict = 'act' | 'watch' | 'hold' | 'ignore'
type Tab = 'now' | 'news' | 'plan' | 'settings'

interface Wx {
  roof?: string | null
  tempF?: number | null
  windMph?: number | null
  rainPct?: number | null
  summary?: string | null
}

/*
 * The sky over each game, drawn rather than described.
 *
 * Every game gets one, including the fair ones: a blank where a forecast should
 * be reads as missing data, and "nothing worth mentioning" is itself worth
 * knowing when you are choosing between two men. The written summary stays for
 * the close-call card, where two players are being compared closely enough to
 * deserve sentences.
 *
 * Drawn as SVG rather than set as emoji: these inherit the row's colour, hold
 * their shape at eleven pixels, and look the same on every machine, none of
 * which is true of ⛅.
 */
const WX_ICON: Record<string, { d: string; extra?: string; solid?: boolean }> = {
  // A roof: the arch and the ground it stands on.
  dome: { d: 'M2 12.5a6 6 0 0 1 12 0z', extra: 'M1 12.5h14', solid: true },
  sun: { d: 'M8 4.9a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 1 0 0-6.2', extra: 'M8 .8v1.8M8 13.4V15.2M.8 8h1.8M13.4 8H15.2M3 3l1.3 1.3M11.7 11.7l1.3 1.3M13 3l-1.3 1.3M4.3 11.7L3 13', solid: true },
  rain: { d: 'M4.5 10a3 3 0 0 1 .5-6a4 4 0 0 1 7.3 1.5A2.6 2.6 0 0 1 12 10z', extra: 'M5.5 12l-.8 2M8 12l-.8 2M10.5 12l-.8 2', solid: true },
  snow: { d: 'M8 2v12M3 5l10 6M13 5L3 11', extra: '' },
  wind: { d: 'M2 5.5h7a2 2 0 1 0-2-2', extra: 'M2 9h9.5a2 2 0 1 1-2 2M2 12.5h5' },
}

function forecastOf(w: Wx | null | undefined) {
  if (!w || !w.roof) return null
  if (w.roof === 'dome') return { icon: 'dome', tone: 'calm', word: 'Indoors', label: 'Indoors' }
  const t = w.tempF, wind = w.windMph ?? 0, rain = w.rainPct ?? 0
  const deg = t != null ? `${Math.round(t)}°` : ''
  /*
   * A retractable roof is said rather than assumed. Whether it is shut on the
   * day is not in any feed here, so the forecast is reported as if it were
   * open and the roof is named — which is the honest version of not knowing.
   */
  const roof = w.roof === 'retractable' ? ' · retractable roof' : ''
  if (rain >= 50 && t != null && t <= 32) return { icon: 'snow', tone: 'rough', word: 'Snow likely', label: `Snow likely, ${deg}${roof}` }
  if (rain >= 50) return { icon: 'rain', tone: 'rough', word: 'Rain likely', label: `${Math.round(rain)}% rain, ${deg}${roof}` }
  if (wind >= 15) return { icon: 'wind', tone: 'rough', word: 'Windy', label: `Wind ${Math.round(wind)} mph, ${deg}${roof}` }
  if (t != null && t <= 25) return { icon: 'snow', tone: 'rough', word: 'Cold', label: `Cold, ${deg}${roof}` }
  /*
   * Heat counts too. Ninety-nine degrees in Dallas was being reported as
   * "fair", which is a sentence the number in it contradicts.
   */
  if (t != null && t >= 90) return { icon: 'sun', tone: 'rough', word: 'Hot', label: `Hot, ${deg}${roof}` }
  return { icon: 'sun', tone: 'calm', word: 'Fair', label: `Fair, ${deg}${roof}` }
}

/**
 * The numbers behind the icon, for the reader who stops to ask.
 *
 * The icon says the shape of the day in one glance and that is all it should
 * have to say; degrees, miles an hour and a chance of rain are what you want
 * once you are already weighing one man against another, which is a decision
 * you make with the cursor sitting still.
 *
 * Under a closed roof they are left off entirely: the feed reports the city's
 * weather, not the game's, and forty degrees beside an indoor kickoff is a
 * fact about the car park.
 */
function wxTitle(w: Wx, word: string, roof: string | null | undefined): string {
  if (roof === 'dome') return 'Indoors · weather is not a factor'
  const bits = [word]
  if (w.tempF != null) bits.push(`${Math.round(w.tempF)}°F`)
  if (w.windMph != null) bits.push(`wind ${Math.round(w.windMph)} mph`)
  if (w.rainPct != null) bits.push(`${Math.round(w.rainPct)}% chance of rain`)
  if (roof === 'retractable') bits.push('retractable roof')
  return bits.join(' · ')
}

function GameWx({ w }: { w: Wx | null | undefined }) {
  const f = forecastOf(w)
  if (!f) return null
  const g = WX_ICON[f.icon]
  const said = wxTitle(w!, f.word, w!.roof)
  /*
   * The numbers used to ride in the SVG's own <title>, which is the browser's
   * native tooltip — and a native tooltip over an icon has two faults that
   * only show up once you try to use one. It answers painted geometry only,
   * so the gaps between a sun's rays are dead ground and the hover lands on
   * nothing; and when it does answer it is after the operating system's own
   * pause, in the operating system's own typeface. Drawn here instead, it
   * answers the whole eighteen pixels and answers them at once.
   *
   * The body of the sun, the cloud and the roof are filled rather than drawn.
   * At this size an outlined sun is eight hairlines around a hole, which reads
   * as an asterisk and disappears next to twelve-point type; the same shape
   * filled is a disc you cannot miss. Rays, drops and gusts stay as strokes,
   * because that is what they are.
   */
  return (
    <span className="cktip">
      <svg className={`ckwx ${f.icon} ${f.tone}`} viewBox="0 0 16 16" width="18" height="18"
           role="img" aria-label={said}>
        <path d={g.d} fill={g.solid ? 'currentColor' : 'none'} stroke="currentColor"
              strokeWidth={g.solid ? 0.9 : 1.6} strokeLinecap="round" strokeLinejoin="round" />
        {g.extra && <path d={g.extra} fill="none" stroke="currentColor" strokeWidth="1.6"
                          strokeLinecap="round" />}
      </svg>
      {/* Already spoken by the icon's own label, so not read out twice. */}
      <span className="cktip-body" aria-hidden="true">{said}</span>
    </span>
  )
}

/**
 * Who a receiver draws. From the chart where one has been read in — a score for
 * every receiver — or else the column's upgrade or downgrade for the few it
 * names.
 */
interface Cover {
  corner: string
  score?: number | null
  offence?: number | null
  defence?: number | null
  side?: 'upgrade' | 'downgrade' | null
  slot?: boolean
  cornerHurt?: boolean
  safety?: boolean
  link?: string | null
}

/*
 * Coloured only past two and a half either way. The chart shades every cell on
 * a continuous scale, and a +0.2 painted green would claim a matchup nobody
 * called good; the six RotoBaller singled out this week all sit beyond it.
 */
const COVER_TINT = 2.5

function CoverageTag({ c }: { c?: Cover | null }) {
  if (!c) return null
  const scored = typeof c.score === 'number'
  const lean = scored
    ? (c.score! >= COVER_TINT ? 'up' : c.score! <= -COVER_TINT ? 'down' : 'even')
    : c.side === 'upgrade' ? 'up' : c.side === 'downgrade' ? 'down' : 'even'
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`
  const label = scored
    ? `CB ${surname(c.corner)} ${c.score! > 0 ? '+' : ''}${c.score!.toFixed(1)}`
    : `${lean === 'up' ? '▲' : '▼'} CB ${surname(c.corner)}`
  /*
   * The numbers behind the score and the caveats the chart printed as colour:
   * a corner marked injured may not be the one who shows up, and a safety in
   * the slot is a different assignment from the corner the name suggests.
   */
  const said = [
    scored
      ? `Matchup ${signed(c.score!)} against ${c.corner}: his adjusted offence ` +
        `${c.offence?.toFixed(2)} to the corner's adjusted defence ${c.defence?.toFixed(2)}.`
      : `RotoBaller's column calls his matchup with ${c.corner} ${c.side === 'upgrade' ? 'an upgrade' : 'a downgrade'}.`,
    c.slot ? 'Works from the slot.' : null,
    c.safety ? `${c.corner} is a safety covering the slot.` : null,
    c.cornerHurt ? `${c.corner} is injured, so the assignment may change.` : null,
    `RotoBaller's WR/CB ${scored ? 'chart' : 'column'}${c.link ? ' — click to read it' : ''}.`,
  ].filter(Boolean).join(' ')
  const chip = <span className={`ckcov ${lean}`}>{label}</span>
  return (
    <span className="cktip">
      {c.link
        ? <a className="ckcova" href={c.link} target="_blank" rel="noopener noreferrer" aria-label={said}>{chip}</a>
        : <span aria-label={said}>{chip}</span>}
      <span className="cktip-body" aria-hidden="true">{said}</span>
    </span>
  )
}

interface PivotCover { id: string; name: string; pos: string | null; projected: number | null; kickoff: number }
interface Pivot {
  playerId: string; name: string; kickoff: number; inactivesAt: number
  plan: 'covered' | 'use-flex' | 'decide-early' | 'no-cover'
  direct: PivotCover[]; viaFlex: PivotCover[]; flex: string | null
  moveBy: number | null; decideBy: number | null
  projected?: number | null
  decideAmong?: PivotCover[]
  /** A free agent better than the bench; `onWaivers` if he is claimed overnight rather than added now. */
  pickup?: (PivotCover & { onWaivers?: boolean }) | null
  /** A free agent whose own game starts after his status is known. */
  keepsOpen?: (PivotCover & { onWaivers?: boolean }) | null
  /** Another questionable starter at his position, with nobody of it on the bench. */
  alsoDoubtful?: { id: string; name: string; pos: string | null }[]
  /** The rearrangement that covers his slot, where nothing on the bench can. */
  shuffle?: { up: PivotCover; from: string; in: PivotCover; to: string; by: number } | null
}

const at = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const names = (cs: PivotCover[], withPos: boolean) =>
  cs.slice(0, 2).map((c) => (withPos && c.pos ? `${c.name} (${c.pos})` : c.name)).join(' or ')
/* A replacement is only worth naming beside what he would cost you in points. */
const named = (cs: PivotCover[], count = 2) =>
  cs.slice(0, count)
    .map((c) => `${c.name}${c.projected != null ? ` ${c.projected.toFixed(1)}` : ''}`)
    .join(' or ')

/*
 * The plan under a questionable starter's card. It says when his status will
 * be known and what can still be done then — the thing "line up the pivot
 * now" means, worked out from kickoffs rather than left to the reader.
 */
function PivotLine({ plan }: { plan: Pivot }) {
  const news = at(plan.inactivesAt)
  const his = plan.projected != null ? ` against his ${plan.projected.toFixed(1)}` : ''
  let said: string
  switch (plan.plan) {
    case 'covered':
      said = `If he is ruled out when inactives come at ${news}, ${named(plan.direct)}${his} can still come in.`
      break
    case 'use-flex':
      said = `Have him in your ${plan.flex}${plan.moveBy ? ` before ${at(plan.moveBy)}` : ''}: ` +
        `if he is ruled out at ${news}, ${names(plan.viaFlex, true)}${his} can still take his place from there.`
      break
    case 'decide-early':
      /* Who the decision is between, since it has to be made blind. */
      said = `Everyone who could replace him has kicked off before his status is known at ${news}. ` +
        `Decide by ${at(plan.decideBy!)}${
          plan.decideAmong?.length ? `, between him and ${named(plan.decideAmong)}${his}` : ''}.`
      break
    default:
      said = plan.shuffle
        ? `Nothing on your bench can fill his slot, and by the time his status is known at ${news} nobody can move into it.`
        : 'Nobody on your bench could replace him, so there is nothing to line up.'
  }
  return (
    <span className={`ckpivot ${plan.plan}`}>
      {said}
      {/* Only where the wire can be seen at all: Sleeper, and a Yahoo league
          once the API has read every roster in it. */}
      {plan.pickup && (
        <> {plan.pickup.onWaivers ? 'On waivers, claimable overnight' : 'Free on the wire'}: <b>{plan.pickup.name}</b>
          {plan.pickup.projected != null ? ` at ${plan.pickup.projected.toFixed(1)}` : ''}, better than
          anything on your bench.</>
      )}
      {/*
        * The rearrangement, and the hour it has to happen in. A man whose game
        * has begun cannot change slots, so this deadline is the earlier of the
        * two kickoffs — which for a Monday-night receiver covered by the
        * Sunday flex is Sunday morning, hours before his own news.
        */}
      {plan.shuffle && (
        <> Before {at(plan.shuffle.by)} you can move <b>{plan.shuffle.up.name}</b> up from your{' '}
          {plan.shuffle.from} and start <b>{plan.shuffle.in.name}</b>
          {plan.shuffle.in.projected != null ? ` (${plan.shuffle.in.projected.toFixed(1)})` : ''} in the{' '}
          {plan.shuffle.to} — which benches {plan.name}, so it is a decision and not a contingency.</>
      )}
      {/*
        * The man who turns a blind decision into a sighted one. Said even
        * where he projects below the bench: what he is worth is the hour, not
        * the points.
        */}
      {plan.keepsOpen && plan.keepsOpen.id !== plan.pickup?.id && (
        <> Or keep it open: <b>{plan.keepsOpen.name}</b>
          {plan.keepsOpen.pos ? ` (${plan.keepsOpen.pos})` : ''} is{' '}
          {plan.keepsOpen.onWaivers ? 'claimable overnight' : 'free'}
          {plan.keepsOpen.projected != null ? ` at ${plan.keepsOpen.projected.toFixed(1)}` : ''} and
          does not kick off until {at(plan.keepsOpen.kickoff)}, after his status is known — with him
          on the bench the choice waits for the news instead of being guessed.</>
      )}
      {!!plan.alsoDoubtful?.length && (
        <span className="ckpivot-both">
          {plan.alsoDoubtful.map((o) => o.name).join(' and ')}{' '}
          {plan.alsoDoubtful.length > 1 ? 'are' : 'is'} questionable too, and you have no other{' '}
          {plan.alsoDoubtful[0].pos ?? 'player'} on the bench — if they both sit, a slot scores nothing.
        </span>
      )}
    </span>
  )
}

interface AnalystRecord {
  analyst: string; credential: string; outlet: string
  right: number; wrong: number; hedged: number; pending: number
}
interface ExpertTake {
  id: string; week: number; player: string; team: string
  analyst: string; credential: string; outlet: string
  call: 'plays' | 'game-time' | 'sits' | 'out-weeks'; weeks: [number, number] | null
  note: string; link: string; at: string
  outcome: 'right' | 'wrong' | 'hedged' | 'pending'
  record: AnalystRecord | null
}

const callShort = (t: ExpertTake) =>
  t.call === 'plays' ? 'plays'
    : t.call === 'sits' ? 'sits'
    : t.call === 'game-time' ? 'game-time'
    : t.weeks && t.weeks[0] === t.weeks[1] ? `out ${t.weeks[0]}` : `out ${t.weeks?.[0]}–${t.weeks?.[1]}`
const callSaid = (t: ExpertTake) =>
  t.call === 'plays' ? 'expects him to play'
    : t.call === 'sits' ? 'expects him to sit'
    : t.call === 'game-time' ? 'calls it a game-time decision'
    : `expects him to miss ${t.weeks && t.weeks[0] === t.weeks[1] ? t.weeks[0] : `${t.weeks?.[0]} to ${t.weeks?.[1]}`} games`
const recordSaid = (r: AnalystRecord | null) => {
  if (!r) return ''
  const graded = r.right + r.wrong
  return graded
    ? ` Record this season: ${r.right} of ${graded} calls right${r.hedged ? `, ${r.hedged} game-time` : ''}${r.pending ? `, ${r.pending} still open` : ''}.`
    : ` No call of theirs has been settled yet${r.pending ? ` (${r.pending} open)` : ''}.`
}

/*
 * An analyst's call on one of our players. The letters are the outlet's: a
 * physical therapist is not promoted to doctor by the app, and the record on
 * hover says more about how far to trust the call than they do.
 */
function TakeChips({ takes }: { takes?: ExpertTake[] | null }) {
  if (!takes?.length) return null
  return (
    <>
      {takes.slice(0, 2).map((t) => {
        const said = `${t.analyst}, ${t.credential} — ${t.outlet}, ` +
          `${new Date(`${t.at}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ` +
          `${callSaid(t)}. ${t.note}${recordSaid(t.record)} Click to read it.`
        return (
          <span className="cktip cktake-w" key={t.id}>
            <a className={`cktake ${t.call}`} href={t.link} target="_blank" rel="noopener noreferrer" aria-label={said}>
              {surname(t.analyst)} {t.credential.replace(/, ?/g, '/')} · {callShort(t)}
            </a>
            <span className="cktip-body" aria-hidden="true">{said}</span>
          </span>
        )
      })}
    </>
  )
}

/** A measured play rate: "played 84%" is always "816 of 968". */
interface PlayRate { rate: number; played: number; listed: number; basis: string; seasons?: [number, number] }

const pct = (r: PlayRate) => `${Math.round(r.rate * 100)}%`

/** The count behind a rate, as a sentence. */
function rateSaid(r: PlayRate, pending?: boolean | null): string {
  const span = r.seasons ? ` (${r.seasons[0]}–${r.seasons[1]})` : ''
  return `${r.played.toLocaleString()} of ${r.listed.toLocaleString()} played — ${r.basis}${span}.` +
    (pending ? ' His club has not set game statuses yet, so this reads the practice log so far.' : '')
}

/*
 * The practice line on a roster row. It used to print the practice status in
 * the colour of a hand-set guess; it now says the status short and what a week
 * like it has meant, measured, with the count one hover away.
 *
 * A rest day is named, because a starter who did not practise reads as a
 * problem until you know why: Christian McCaffrey sat out on the Thursday this
 * was built, and the old reading called him likely out.
 */
function PracticeLine({ p }: { p: RosterPlayer }) {
  if (!p.practice) return null
  const short = p.practice
    .replace(/ i?n Practice$/i, '')
    .replace('Did Not Participate', 'DNP')
    .replace('Limited Participation', 'limited')
    .replace('Full Participation', 'full')
  const why = p.reportInjury && /^not injury related|rest|personal|illness/i.test(p.reportInjury)
    ? ` (${/rest/i.test(p.reportInjury) ? 'rest day' : p.reportInjury.replace(/^Not Injury Related - /i, '').toLowerCase()})`
    : ''
  return (
    <span className={`ckprac ${p.severity ?? ''}`}>
      {' · '}{short}{why}
      {/* The separator sits outside the hover box: a space leading an
          inline-block collapses, and "(rest day)· plays" is what it left. */}
      {p.playRate && ' · '}
      {p.playRate && (
        <span className="cktip ckprate">
          <span>plays {pct(p.playRate)}</span>
          <span className="cktip-body" aria-hidden="true">{rateSaid(p.playRate, p.reportPending)}</span>
        </span>
      )}
    </span>
  )
}

/** Actual against projected, over the starters whose games have finished. */
interface PaceOf { done: number; of: number; got: number; due: number }
/** A chance, as a sentence rather than a decimal: the model is too rough for one. */
const chanceWords = (p: number) =>
  p >= 0.97 ? 'all but won' : p <= 0.03 ? 'all but lost' : `${Math.round(p * 100)}% to win`
/** Where a season stands. Points against is null where the platform is silent. */
interface Standing {
  wins: number; losses: number; ties: number
  place: number | null; pointsFor: number | null; pointsAgainst: number | null
}
/*
 * "1-0" rather than "1-0-0": a tie is rare enough that printing a nought for it
 * every week costs more attention than it earns, and it still shows the moment
 * there is one.
 */
const wl = (r: Standing) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`
/* Gold, silver, bronze, and one colour for everyone else. */
const podium = (place: number) => (place <= 3 ? ` p${place}` : '')
/**
 * Where the defence he faces ranks against his position, said the way both
 * league apps say it: a number beside the opponent, green when it is a
 * defence to attack and red when it is one to avoid. Rank one concedes most.
 */
function DefenceRank({ p }: { p: { dvpRank?: number | null; dvpOf?: number | null } }) {
  if (p.dvpRank == null || !p.dvpOf) return null
  const third = p.dvpOf / 3
  const tone = p.dvpRank <= third ? 'soft' : p.dvpRank > p.dvpOf - third ? 'hard' : ''
  return (
    <i className={`ckdvp ${tone}`}
       title={`${ordinal(p.dvpRank)} of ${p.dvpOf} in points conceded to his position — 1st concedes most`}>
      {ordinal(p.dvpRank)}
    </i>
  )
}

/** A guillotine week: my place among the survivors by projection, and the cushion over the lowest. */
interface Chop {
  week: number | null; place: number; of: number
  projected: number | null; points: number | null
  fromChop: number | null; cushion: number | null; onTheBlock: boolean
  bottom: { teamId: string; name: string; manager: string; mine: boolean
            projected: number | null; points: number | null; faab: number | null }[]
  faab: number | null; at: number
}
interface Tile {
  id: string; label: string; platform: string; format: string; teams: number
  urgency: Urgency; why: string; action: string; freshMs: number | null
  draft: { at: string; inMs: number; slotSet: boolean; boardAgeMs: number | null } | null
  blocked: string | null; phase: string
  /** Where the season stands, where the platform says. */
  standing: Standing | null
  /** Where the week stands, while it is being played. */
  score: {
    mine: number; theirs: number | null; margin: number | null; note: string
    /** Actual against projected, over the starters who have finished. */
    pace: PaceOf | null
    /** The one or two players moving this league's margin. */
    movers: { name: string; swing: number; live: boolean }[]
    /** When nobody has moved much yet: the most-expected starter's progress. */
    lead: { name: string; got: number; due: number } | null
  } | null
  chop?: Chop | null
  startsWeek?: number | null
}
interface Why { note: string | null; headline: string | null; link: string | null }
interface MatchupPlayer {
  /** The slot he fills, so what is left can be read as a lineup. */
  slot?: string | null
  /** 'Yahoo' or 'Sleeper': whose projection this row shows. */
  projectedFrom?: string | null
  id: string; name: string; pos: string | null; team: string | null
  projected: number | null; injuryStatus: string | null; injuryBody: string | null
  /** What they have actually scored. Null until the week is under way. */
  points: number | null
  /** Where his club's game stands, so a row can show he is on the field now. */
  game?: 'pre' | 'playing' | 'done' | null
  why?: Why | null
  /** The week behind the designation, as the roster row has it. */
  practice?: string | null
  severity?: string | null
  playRate?: PlayRate | null
  reportPending?: boolean | null
  reportInjury?: string | null
}
type Group = 'needs' | 'opening' | 'rising' | 'knowing'
interface Chip { leagueId: string; label: string; note: string; tone: 'act' | 'watch' | 'hold' | 'free' }
interface Item {
  id: string; group: Group; headline: string; detail: string; at: number
  playerId: string | null; chips: Chip[]; weight: number; because?: string | null
  practice?: { status: string; severity: string; report: string } | null
  why?: { note: string | null; headline: string | null; link: string | null } | null
}
interface WireItem {
  id: string; title: string; summary: string; at: number; source: string; link: string
  mentions: { id: string; name: string; leagues: string[] }[]
}
interface Check { k: string; ok: boolean; v: string }
interface RosterPlayer {
  /** 'Yahoo' or 'Sleeper': whose projection this row is showing. */
  projectedFrom?: string | null
  id: string; name: string; pos: string | null; team: string | null; byeWeek: number | null
  injuryStatus: string | null; injuryBody: string | null; starter: boolean
  practice: string | null
  severity: 'likely-out' | 'coin-flip' | 'likely-plays' | 'unknown' | null
  why?: Why | null
  projected?: number | null
  /** Who his club faces this week, from the schedule. */
  opponent?: string | null
  /** What that defence concedes to his position — silent until games are played. */
  matchupNote?: string | null
  /** Where that defence ranks against his position, and of how many. */
  dvpRank?: number | null
  dvpOf?: number | null
  /** The sky over his game, or the roof between him and it. */
  weather?: Wx | null
  /** The corner he draws, where RotoBaller's WR/CB chart or column named him. */
  coverage?: Cover | null
  /** How often a report like his has meant playing, with the count behind it. */
  playRate?: PlayRate | null
  /** His club has not set this week's game statuses yet. */
  reportPending?: boolean | null
  /** What the injury report names, which the platform's tag may not. */
  reportInjury?: string | null
  /** What injury analysts have said about him this week, newest first. */
  takes?: ExpertTake[] | null
}
interface Detail {
  id: string; label: string; platform: string; teams: number; rounds: number
  /** Where the season stands, where the platform says. */
  standing: Standing | null
  starters: Record<string, number>; flex: { name: string; count: number }[]; benchSize: number
  draftTime: string | null; mySlot: number | null; feed: string
  preDraft: boolean; msToDraft: number | null; checks: Check[]
  roster: {
    players: RosterPlayer[]; starters: string[]; capturedAt?: number
    /** What to do about each questionable starter before his status is known. */
    pivots?: Pivot[]
    advice?: {
      gain: number
      decisive?: number
      closeCalls?: {
        slot: string; gap: number; by: 'consensus' | 'role' | 'matchup' | 'projection' | 'nothing'
        /** Inside the coin flip, where the projection said nothing at all. */
        tight?: boolean
        split?: {
          votes: { signal: string; prefers: string; why: string }[]
          caveat: string | null
        } | null
        keep: any; alternative: any; change?: boolean
        /** A free agent better than both, by more than a coin flip, scored the league's way. */
        wire?: { id: string; name: string; pos: string | null; projected: number | null
                 onWaivers: boolean; over: number } | null
      }[]
      swaps: {
        in: { id: string; name: string; pos: string | null; projected: number | null }
        out: { id: string; name: string; pos: string | null; projected: number | null
               injuryStatus: string | null } | null
        slot: string; gain: number; reason: 'points' | 'out' | 'empty'; close?: boolean
        /** Nobody read the outgoing man's projection, so there is no gain to state. */
        unknownOut?: boolean
      }[]
    } | null
    projectedTotal?: number; week?: number; projectionSource?: string
    projectionCoverage?: { counted: number; of: number; filled?: number }
  } | null
  /** Everything the rules say needs you, unrationed by the alert budget. */
  needs: { rule: string; headline: string; detail: string; consequence: number
           deadline: number | null; playerId?: string | null }[]
  /** Weeks ahead where byes bite, soonest first. */
  byes: { week: number; away: number; shortfalls: { slot: string; reason: string }[] }[] | null
  connected: boolean; blocked: string | null
  matchup: {
    week: number; opponent: string; started: boolean
    /* Yahoo states the opponent's total on the team page; some leagues have
       none to state, and a missing half is not a nought. */
    live: { mine: number; theirs: number | null }
    projected: { mine: number; theirs: number | null }
    projectionsAt: number
    /** The chance of winning from here, 0 to 1, while the week is live. */
    win?: number | null
    mine: MatchupPlayer[]
    theirs: MatchupPlayer[]
    /** His starters who cannot score, where his lineup has been read. */
    theirBroken?: { why: string } | null
  } | null
  drafts: { key: string; picks: number; at: number; mySlot: number | null
            teams: number; rounds: number; exact: boolean }[]
  /** A guillotine league's week, where the API has read it. */
  guillotine?: Chop | null
  /** A league found through the API that has not played its first week. */
  startsWeek?: number | null
  /** Record against the draw, and against the whole league. Null until there are weeks. */
  allPlay?: {
    mine: LuckRow | null
    table: (LuckRow & { manager: string })[]
  } | null
  /** The weeks already played, against the best lineup each roster could have made. */
  startSit?: {
    share: number | null
    left: number
    weeks: {
      week: number; actual: number; perfect: number; left: number; share: number | null
      missed: { in: string; out: string; slot: string; gain: number }[]
    }[]
  } | null
  /** What the rest of the league did that bears on me. */
  moves?: {
    move: { id: string; at: number; type: string; manager: string }
    kind: 'dropped-worth-having' | 'rival-filling-my-hole' | 'touched-mine'
    player: { id: string; name: string; pos: string | null }
    headline: string
  }[] | null
  waivers?: {
    budget: number | null; spent: number | null; clearsAt: number | null
    holes: { slot: string; pos: string[]; reason: string }[]
    targets: { id: string; name: string; pos: string | null; team: string | null
               projected: number | null; fills: string; onWaivers?: boolean }[]
    freeAsOf?: number | null
  } | null
}
interface Tally { wins: number; losses: number; ties: number; pct: number | null }
interface LuckRow { teamId: string; actual: Tally; deserved: Tally; games: number | null }

interface Note {
  id: string; at: number; title: string; body: string
  deadline: string | null; leagues: string[]; rule: string; read: boolean
}
interface Ev {
  id: string; at: number; kind: string; name: string; pos: string; team: string
  from: string; to: string; body: string | null; worse: boolean
}

interface Source {
  id: string; label: string; platform: string; feed: string; mySlot: number | null
  teams: number; rounds: number; draftTime: string | null; boardAt: string | null
  connected: boolean; note: string
}

const HOUR = 3600000, DAY = 24 * HOUR

function inWords(ms: number): string {
  if (ms <= 0) return 'now'
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.round((ms % HOUR) / 60000)}m`
  const h = Math.round(ms / HOUR)
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
function agoWords(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < HOUR) return `${Math.round(ms / 60000)}m ago`
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`
  return `${Math.round(ms / DAY)}d ago`
}
function freshWords(ms: number | null): string {
  if (ms == null) return 'no feed'
  if (ms < 60000) return 'fresh now'
  if (ms < HOUR) return `fresh ${Math.round(ms / 60000)}m`
  return `fresh ${Math.round(ms / HOUR)}h`
}

/* ------------------------------------------------------------------ shell */

/*
 * Four destinations, not five. Byes and budgets are facts about one league and
 * belong on its screen; what is genuinely cross-league earns a place. That is
 * two things now rather than one — the wire on a Monday and trades — so they
 * share the tab as segments instead of taking a fifth of the bar each. Review
 * is opened a handful of times a season, so it sits under Settings.
 */
const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' }, { id: 'news', label: 'News' },
  { id: 'plan', label: 'Moves' }, { id: 'settings', label: 'Set' },
]

function Seg<T extends string>({ opts, on, set }: { opts: T[]; on: T; set: (v: T) => void }) {
  return (
    <div className="ckseg" role="tablist">
      {opts.map((o) => (
        <button key={o} role="tab" aria-selected={o === on}
          className={o === on ? 'on' : ''} onClick={() => set(o)}>{o}</button>
      ))}
    </div>
  )
}

function Head({ big, sub, beside }: { big: string; sub?: string; beside?: ReactNode }) {
  return (
    <header className="ckhdr">
      {/* Whatever belongs with the title rather than with the page chrome. */}
      <div className="ckbig">{big}{beside}</div>
      {sub && <div className="cksub">{sub}</div>}
    </header>
  )
}

/* -------------------------------------------------------------------- now */

/**
 * A league's own colour, everywhere it appears.
 *
 * Four leagues get named on half a dozen screens — tiles, the exposure list,
 * trade partners, news chips — and reading the label every time is work the
 * eye should not have to do. Derived from the id rather than configured, so a
 * new league gets one without being told, and stays the same colour for as
 * long as it keeps its id.
 */
const LEAGUE_HUES = [199, 152, 41, 320, 265, 12]
export function leagueHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return LEAGUE_HUES[h % LEAGUE_HUES.length]
}
/** The style object that carries it into CSS. */
export const leagueStyle = (id: string) =>
  ({ '--lg': `hsl(${leagueHue(id)} 70% 62%)` }) as React.CSSProperties

/*
 * Inside three points a margin is not yet a lead.
 *
 * The tag used to replace the number with the word "Level", which put it in
 * flat contradiction with the sentence right above it: the card read
 * "Trailing 1.9" and the tag called the week level. Each was defensible and
 * together they were nonsense.
 *
 * So direction and size are told by different channels. The arrow and the
 * number always say which way it is going, because that part is simply true.
 * The colour says the only thing they cannot — whether the gap is big enough
 * to mean anything yet. Amber reads "behind, but by less than one big play".
 *
 * A finished week is exempt: a result is a result, and a man who won by half
 * a point still won.
 */
const LEVEL = 3

/**
 * Which way the week is going, in a colour you can read from across the room.
 *
 * The sentence on the card already says "Trailing 6.6", and five cards of
 * prose all look identical at a glance — which is the one thing a home screen
 * has to get right. The arrow and the number carry the meaning on their own,
 * so the colour is a second telling rather than the only one.
 */
function ScoreTag({ t }: { t: Tile }) {
  const m = t.score?.margin
  if (t.phase !== 'live' || m == null) return null
  const settled = t.action === 'Won' || t.action === 'Lost'
  const close = !settled && Math.abs(m) < LEVEL
  const tone = close ? 'level' : m >= 0 ? 'up' : 'down'
  const gap = Math.abs(m).toFixed(1)
  const way = m >= 0 ? 'Ahead' : 'Behind'
  return (
    <span
      className={`cksc ${tone}`}
      title={
        settled
          ? `${m >= 0 ? 'Won' : 'Lost'} by ${gap} — ${t.score!.mine.toFixed(1)} to ${t.score!.theirs?.toFixed(1)}`
          : close
            ? `${way} by ${gap} — inside a single big play`
            : `${way} by ${gap}`
      }
    >
      <i className="ckscar">{m === 0 ? '=' : m > 0 ? '\u25b2' : '\u25bc'}</i>
      {gap}
      <em>{t.score!.mine.toFixed(1)}–{t.score!.theirs?.toFixed(1)}</em>
      <Pace pace={t.score!.pace} />
    </span>
  )
}

/*
 * A guillotine week's number: the cushion over the lowest of the others.
 *
 * The same place and size as a head-to-head margin, because it answers the
 * same question — how is this week going — and a guillotine tile that showed
 * a margin over the chopping block read like a game being won or lost.
 */
function ChopTag({ c }: { c: Chop }) {
  if (c.cushion == null) return null
  const danger = c.place > c.of - 3
  const tone = c.onTheBlock ? 'down' : danger ? 'level' : 'up'
  const gap = Math.abs(c.cushion).toFixed(1)
  return (
    <span
      className={`cksc ${tone}`}
      title={c.onTheBlock
        ? `Projected lowest — ${gap} below the next team up`
        : `Projected ${ordinal(c.place)} of ${c.of} — ${gap} clear of whoever is projected lowest`}
    >
      <i className="ckscar">{c.onTheBlock ? '\u25bc' : '\u25b2'}</i>
      {gap}
      <em>{c.onTheBlock ? 'on the block' : 'clear of the chop'}</em>
    </span>
  )
}

/*
 * A surname, for a line meant to be glanced at. Suffixes are dropped first,
 * or Travis Etienne Jr. would be reported as "Jr." — and a team defence keeps
 * its nickname, which is the part anyone says aloud.
 */
const surname = (full: string) => {
  const parts = full.replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim().split(/\s+/)
  return parts[parts.length - 1] ?? full
}

/**
 * Why a tile reads the way it does: the players moving its margin.
 *
 * On the left, under the sentence, where the tile had room to spare — so each
 * arrow on the home screen arrives with its own "because" and the card gains
 * no height. A player still on the field is set in italics: he is only
 * reported once he is already past his projection, so his number is a floor
 * that can still climb.
 */
function Movers({ score }: { score: NonNullable<Tile['score']> }) {
  if (score.movers.length) {
    return (
      <div className="ckmov">
        {score.movers.map((m, i) => (
          <span
            key={m.name}
            className={`${m.swing >= 0 ? 'up' : 'down'}${m.live ? ' live' : ''}`}
            title={`${m.name}: ${m.swing >= 0 ? 'ahead of' : 'short of'} his projection by ${
              Math.abs(m.swing).toFixed(1)}${m.live ? ', and still playing' : ''}`}
          >
            {i > 0 && <span className="ckmovsep"> · </span>}
            {surname(m.name)} {m.swing >= 0 ? '+' : '\u2212'}{Math.abs(m.swing).toFixed(1)}
          </span>
        ))}
      </div>
    )
  }
  if (score.lead) {
    return (
      <div className="ckmov" title={`${score.lead.name}, the starter you were counting on most`}>
        {surname(score.lead.name)} {score.lead.got.toFixed(1)} of {score.lead.due.toFixed(1)}
      </div>
    )
  }
  return null
}

/**
 * How the finished men did against what they were due.
 *
 * Under the scoreline rather than beside it, and quiet unless it is saying
 * something: level is the common case and does not need a colour.
 */
function Pace({ pace }: { pace: PaceOf | null }) {
  if (!pace) return null
  const delta = pace.got - pace.due
  if (Math.abs(delta) < 1) return <em className="ckscp">on pace · {pace.done}/{pace.of} done</em>
  return (
    <em className={`ckscp ${delta > 0 ? 'up' : 'down'}`}>
      {Math.abs(delta).toFixed(1)} {delta > 0 ? 'ahead' : 'behind'} · {pace.done}/{pace.of} done
    </em>
  )
}

function LeagueCard({ t, onOpen, mark, close }: {
  t: Tile; onOpen: () => void
  mark?: { count: number; worst: number; first: string }
  /** Slots where two players are the same this week and one is on the bench. */
  close?: number
}) {
  const drafting = t.draft != null && t.draft.inMs > 0
  return (
    /*
     * A dot, because everyone already knows what a dot in the corner means.
     * The card says what the matter is and the pill says what to do about it;
     * this only has to catch the eye from across the page, and a tinted
     * background asked the reader to learn a new signal to do it.
     *
     * It takes the pill's colour rather than a red of its own. Red meant only
     * "the rules pass found something here", which put the same alarm over a
     * questionable third receiver as over a lineup that will not field — three
     * red dots on a Tuesday afternoon, and nothing left to say on the day one
     * of them is actually broken. On the same scale as the pill, the two
     * cannot contradict each other and red is worth something again.
     */
    <button className={`ck tap ${t.urgency}`} onClick={onOpen} style={leagueStyle(t.id)}>
      <div className="ckhead">
        {/*
          * One mark, one shape, one place. A close call used to be a little
          * amber word-chip beside the red dot, which read as a different kind
          * of thing entirely — and it was the only card marker that had to be
          * read rather than seen. Same dot, amber instead of red: the colour
          * says how loud, and the card's own sentence says what it is.
          */}
        {(mark || !!close) && (
          <span
            className={`ckdot-alert ${t.urgency}${!mark && close ? ' close' : ''}`}
            title={mark ? mark.first : `${close} close call${close === 1 ? '' : 's'} worth a look`}
            aria-label={mark ? 'needs attention' : 'close call worth a look'}
          />
        )}
        <SportMark sport="nfl" />
        <span className="cknm" title={t.label}>{t.label}</span>
        <span className="ckfmt">{t.format}</span>
        <span className="cksp" />
        {/*
          * After the spacer, so every record lands in the same column down the
          * page. Set beside the league name it began at a different place on
          * every card — "Harker Experi(Mental) League" against "Yahoo H2H-Pts" —
          * and a number you have to hunt for is not one you can glance at, no
          * matter what face it is set in.
          */}
        {/* A guillotine league has no record; its standing is a place among the survivors. */}
        {!t.standing && t.chop && (
          <span className="ckrec" title={`Projected ${ordinal(t.chop.place)} of ${t.chop.of} survivors this week`}>
            <i className={`ckplace${podium(t.chop.place)}${t.chop.place > t.chop.of - 3 ? ' risk' : ''}`}>
              {ordinal(t.chop.place)}
            </i>
            <b className="ckof">/{t.chop.of}</b>
          </span>
        )}
        {t.standing && (
          <span className="ckrec" title={
            `${wl(t.standing)}${t.standing.place ? `, ${ordinal(t.standing.place)} of the league` : ''}` +
            (t.standing.pointsFor != null ? ` · ${t.standing.pointsFor.toFixed(1)} for` : '') +
            (t.standing.pointsAgainst != null ? `, ${t.standing.pointsAgainst.toFixed(1)} against` : '')
          }>
            <b>{wl(t.standing)}</b>
            {t.standing.place != null && (
              <i className={`ckplace${podium(t.standing.place)}`}>{ordinal(t.standing.place)}</i>
            )}
          </span>
        )}
        <span className="ckchev" aria-hidden="true">›</span>
      </div>
      {/*
        * Live weeks put the margin in large type beside the sentence rather
        * than in a chip below it. A tinted chip in the footer was the smallest
        * thing on the card, one of three identical pills, and it repeated a
        * number the sentence had already given — so nothing about it could
        * pop, whatever colour it was. The sentence drops its own leading
        * clause here for the same reason, which also keeps the card one line
        * tall.
        */}
      {t.chop && t.chop.cushion != null ? (
        <div className="cklive">
          <div>
            <div className="ckwhy">
              {t.phase === 'live' && t.chop.points != null
                ? `${t.chop.points.toFixed(1)} so far · projected ${t.chop.projected?.toFixed(1) ?? '—'}.`
                : `Projected ${t.chop.projected?.toFixed(1) ?? '—'} this week.`}
            </div>
            {t.score && <Movers score={t.score} />}
          </div>
          <ChopTag c={t.chop} />
        </div>
      ) : t.score?.margin != null ? (
        <div className="cklive">
          <div>
            <div className="ckwhy">{t.score.note}</div>
            <Movers score={t.score} />
          </div>
          <ScoreTag t={t} />
        </div>
      ) : (
        <div className="ckwhy">{t.why}</div>
      )}
      <div className="ckfoot">
        {/* Amber, like the dot it belongs to: a close call keeps the quiet
            urgency because it is not an instruction, but it is not the green
            of "nothing to do" either. */}
        <span className={`ckpill ${t.urgency}${!mark && close ? ' close' : ''}`}>{t.action}</span>
        {drafting && <span className="ckclock">{inWords(t.draft!.inMs)}</span>}
        <span className="cksp" />
        <span className="ckfresh">{t.blocked ?? freshWords(t.freshMs)}</span>
      </div>
      {/*
        * The way into a draft is the league's own card. A separate "drafts"
        * destination would split one thing in two and sit empty for fifty-one
        * weeks of the year.
        */}
    </button>
  )
}

const URGENCY: Tile['urgency'][] = ['act', 'soon', 'watch', 'quiet', 'blocked']

/**
 * Which sport a card is, before its name is read. The home list mixes both,
 * worst first, and a football card and a basketball card are otherwise the
 * same shape: the mark is the one thing that differs at a glance. Colour as
 * well as letters — green for the field, orange for the ball — so it reads
 * from across the room.
 */
function SportMark({ sport }: { sport: 'nfl' | 'nba' }) {
  return <span className={`cksport ${sport}`} aria-label={sport === 'nfl' ? 'Football' : 'Basketball'}>{sport.toUpperCase()}</span>
}

type SportFilter = 'All' | 'Football' | 'Basketball'
const SPORT_KEY = 'home-sport'

/**
 * The sport filter, at the top of Now, News and Moves alike, and one setting
 * across all three: choosing Basketball on Now means Basketball when News is
 * opened next. Each button counts the leagues of its sport that need you, so a
 * filter never hides that the other sport is waiting.
 */
function SportBar({ on, set, need }: { on: SportFilter; set: (v: SportFilter) => void; need: { nfl: number; nba: number } }) {
  return (
    <div className="ckseg cksportseg" role="tablist" aria-label="Sport">
      {(['All', 'Football', 'Basketball'] as SportFilter[]).map((o) => {
        const n = o === 'Football' ? need.nfl : o === 'Basketball' ? need.nba : 0
        return (
          <button key={o} role="tab" aria-selected={o === on} className={o === on ? 'on' : ''} onClick={() => set(o)}>
            {o === 'Football' && <SportMark sport="nfl" />}{o === 'Basketball' && <SportMark sport="nba" />}
            {o}{n > 0 && <span className="ckbadge">{n}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Sections for both sports under All, each under its own mark, so a long page says which is which. */
function SportHead({ sport }: { sport: 'nfl' | 'nba' }) {
  return <h2 className="cksporthead"><SportMark sport={sport} /> {sport === 'nfl' ? 'Football' : 'Basketball'}</h2>
}

/**
 * A basketball league's card. Same shape and colours as football's, so the
 * home list reads as one list worst-first; it opens the league's own page,
 * because basketball's season screens live in their own bundle.
 */
function NbaCard({ t, onOpen }: { t: SeasonTile; onOpen: (id: string) => void }) {
  const s = t.score
  // The league's page opens inside the app; a draft under way opens its draft room.
  const inside = t.link === `/nba/league/${t.id}`
  return (
    <a className={`ck tap ${t.urgency}`} href={t.link} style={leagueStyle(t.id)}
       onClick={(e) => { if (inside && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(t.id) } }}>
      <div className="ckhead">
        <SportMark sport="nba" />
        <span className="cknm" title={t.label}>{t.label}</span>
        <span className="cksp" />
        {s && s.mine != null && (
          <span className="ckrec" title={s.expected != null ? `${s.expected.toFixed(1)} categories expected` : undefined}>
            <b>{s.mine}–{s.theirs ?? '—'}</b>
            {s.win != null && <i className="ckplace">{Math.round(s.win * 100)}%</i>}
          </span>
        )}
        <span className="ckchev" aria-hidden="true">›</span>
      </div>
      <div className="ckwhy">{t.why}</div>
      <div className="ckfoot">
        <span className={`ckpill ${t.urgency}`}>{t.action}</span>
      </div>
    </a>
  )
}

function Now({ tiles, onOpen, onOpenNba, marks, closeCalls, nba = [], sport, setSport, need: needBy, yahooOff }: {
  tiles: Tile[]; onOpen: (id: string) => void; onOpenNba: (id: string) => void
  marks?: Record<string, { count: number; worst: number; first: string }>
  closeCalls?: Record<string, number>
  nba?: SeasonTile[]
  sport: SportFilter; setSport: (v: SportFilter) => void; need: { nfl: number; nba: number }
  yahooOff?: { why: string; since: number | null; until: number | null } | null
}) {
  /* Counted from what the tiles are actually marked with, so the heading
     cannot say "nothing needs you" over a card that says otherwise. */
  const need: { id: string }[] = [
    ...tiles.filter((t) => marks?.[t.id] || closeCalls?.[t.id] || t.urgency === 'act' || t.urgency === 'soon'),
    ...nba.filter((t) => t.urgency === 'act' || t.urgency === 'soon'),
  ]
  /* Everything marked, across them: a league with two questionable starters
     and one with a close call is three things and two leagues. */
  const things = need.reduce(
    (n, t) => n + (marks?.[t.id]?.count ?? 0) + (closeCalls?.[t.id] ?? 0), 0,
  ) || need.length
  const next = tiles.map((t) => t.draft).filter((d): d is NonNullable<Tile['draft']> => !!d && d.inMs > 0)
    .sort((a, b) => a.inMs - b.inMs)[0]
  const both = tiles.length > 0 && nba.length > 0
  const shown = both ? sport : 'All'
  return (
    <>
      {/*
        * Both numbers, because either alone is a different question. "3 need
        * you" left the reader working out three of what; "2 leagues need you"
        * answered that and hid the size of the job — two leagues can hold one
        * thing or five. So: how much there is, and how far it is spread.
        *
        * The subhead only appears when there is a draft to announce; for
        * fifty-one weeks of the year "No drafts scheduled" was a line that
        * never changed and never said anything.
        */}
      <Head
        big={!need.length
          ? 'Nothing needs you'
          : things === 1 ? 'One thing needs you'
          : need.length === 1 ? `${things} things in one league`
          : `${things} things in ${need.length} leagues`}
        sub={next
          ? `Next draft in ${inWords(next.inMs)} · ${new Date(next.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
          : undefined}
      />
      {/*
        * Why the numbers below have stopped moving.
        *
        * Every tile said "fresh 14h" for half a day while the sync was failing
        * with a reason the server could read off its own state. A freshness
        * number that goes quiet looks like a quiet league; it has to say when
        * it is actually a stopped clock, and when the clock starts again.
        */}
      {yahooOff && (
        <div className="ckstop">
          <b>Yahoo is not being read — {yahooOff.why}.</b>
          {yahooOff.since != null && <> Last read {agoWords(new Date(yahooOff.since).toISOString())}.</>}
          {yahooOff.until != null && <> Resumes {new Date(yahooOff.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</>}
          {' '}Everything below is as it stood then.
        </div>
      )}
      {both && <SportBar on={shown} set={setSport} need={needBy} />}
      <div className="ckgrid ckleagues">
        {/* Worst first across both sports; a basketball card goes ahead of football cards of the same urgency, since a daily lineup locks sooner. */}
        {[...(shown === 'Basketball' ? [] : tiles).map((t) => ({ u: URGENCY.indexOf(t.urgency), el: (
          <LeagueCard key={t.id} t={t} mark={marks?.[t.id]} close={closeCalls?.[t.id]}
                      onOpen={() => onOpen(t.id)} />
        ) })), ...(shown === 'Football' ? [] : nba).map((t) => ({ u: URGENCY.indexOf(t.urgency) - 0.5, el: <NbaCard key={t.id} t={t} onOpen={onOpenNba} /> }))]
          .map((x, i) => ({ ...x, i }))
          .sort((a, b) => a.u - b.u || a.i - b.i)
          .map((x) => x.el)}
      </div>
      {/* Football's cross-league exposure: football names, so not under the basketball filter. */}
      {shown !== 'Basketball' && <Exposure />}
    </>
  )
}

/* ----------------------------------------------------------------- league */

function League({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  /* Which bye week is being inspected, if any. Clicking the same tile again
     clears it, so the roster returns to normal without hunting for a control. */
  const [byeWeek, setByeWeek] = useState<number | null>(null)
  useEffect(() => {
    setD(null)
    setByeWeek(null)
    fetch(`/api/cockpit/league/${id}`).then((r) => r.json()).then(setD).catch(() => setD(null))
  }, [id])

  if (!d) return <div className="ckempty">Reading the league…</div>

  const setRounds = (n: number) =>
    fetch(`/api/league/${d.id}/shape`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: n }),
    }).then(() => fetch(`/api/cockpit/league/${d.id}`)).then((r) => r.json()).then(setD)

  /*
   * One count, from the thing the reader can actually see. The header was
   * counting failed checks while the callout listed rule findings, and the two
   * used different thresholds — so it said "1 thing to sort out" above an empty
   * space, which is worse than saying nothing.
   */
  const open = d.checks.filter((c) => !c.ok)
  const needs = d.needs ?? []
  const lineup = d.roster?.players.filter((p) => p.starter) ?? []
  const bench = d.roster?.players.filter((p) => !p.starter) ?? []
  const slots = [
    ...Object.entries(d.starters).flatMap(([pos, n]) => Array.from({ length: n }, () => pos)),
    ...d.flex.flatMap((f) => Array.from({ length: f.count }, () => f.name)),
  ]

  return (
    <>
      {/* Back lives in the context line rather than a row of its own. */}
      <div className="ckcrumb">
        <button onClick={onBack}>‹ Home</button>
        <span className="cksep">·</span>
        <span>{d.teams} teams · {d.rounds} rounds</span>
        <span className="cksp" />
        <span>{d.connected ? 'connected' : 'no feed'}</span>
      </div>
      {/*
        * The league is the title of its own page.
        *
        * The status held the big type and the league name sat under it in the
        * subtitle, which read as a page about a verdict that happened to
        * concern a league. It is the other way round: you arrive here having
        * chosen a league, and the verdict is what this page says about it.
        */}
      <Head
        big={d.label}
        sub={(d.preDraft
          ? open.length ? `${open.length} to sort out` : 'Ready to draft'
          // After a draft the checks describe the lineup, so the count means
          // something again rather than asserting there is nothing to decide.
          : d.startsWeek != null ? `Starts week ${d.startsWeek}`
          : !d.roster ? 'No roster yet'
          : !lineup.length ? 'Lineup not set'
          : needs.length === 0 ? 'Nothing needs you'
          : needs.length === 1 ? 'One thing needs you'
          : `${needs.length} things need you`)
          + (d.msToDraft != null && d.msToDraft > 0 ? ` · drafts in ${inWords(d.msToDraft)}` : '')}
        /*
         * The season belongs with the league it describes, not in the
         * breadcrumb between the team count and the round count. Up there it
         * read as page furniture — the row you skip to get to the content —
         * and it is the first thing anyone wants to know about a league.
         *
         * Points against only where the platform reports it. Yahoo keeps it on
         * a standings page built in the browser, and a nought would describe a
         * team nobody has scored against.
         */
        beside={!d.standing && d.guillotine ? (
          /* A guillotine league has no record: its standing is a place among the survivors. */
          <span className="ckrecline">
            <i className={`ckplace${podium(d.guillotine.place)}${d.guillotine.place > d.guillotine.of - 3 ? ' risk' : ''}`}>
              {ordinal(d.guillotine.place)}
            </i>
            <em>of {d.guillotine.of} this week
              {d.guillotine.faab != null && ` · $${d.guillotine.faab} FAAB left`}
            </em>
          </span>
        ) : d.standing ? (
          <span className="ckrecline">
            <b>{wl(d.standing)}</b>
            {d.standing.place != null && (
              <i className={`ckplace${podium(d.standing.place)}`}>{ordinal(d.standing.place)}</i>
            )}
            {d.standing.pointsFor != null && (
              <em>{d.standing.pointsFor.toFixed(1)} for
                {d.standing.pointsAgainst != null && ` · ${d.standing.pointsAgainst.toFixed(1)} against`}
              </em>
            )}
          </span>
        ) : undefined}
      />

      {/* The row stays — lineup, worst bye and when this was last seen are
          facts worth having at a glance. Only designations leave it, because
          the callout above now says that, and saying it twice in two voices
          split the reader between two accounts of one thing. */}
      <div className="ckchecks">
        {d.checks.filter((c) => !/designation/i.test(c.k)).map((c) => (
          <div className={`ckchk ${c.ok ? 'ok' : 'no'}`} key={c.k}>
            <span className="ckck">{c.ok ? '✓' : '·'}</span>
            <span className="ckckk">{c.k}</span>
            <span className="ckckv">{c.v}</span>
          </div>
        ))}
      </div>

      {/*
        * The round count decides whether kicker and defence get forced at the
        * end, so it has to be correctable without a restart — and it has to
        * show the value it holds. A row of fixed choices could not: this league
        * runs twenty-one rounds, the buttons offered thirteen to seventeen,
        * nothing highlighted, and the row read as though it said seventeen.
        * A stepper is right at any length and states the number outright.
        */}
      {d.preDraft && (
      <div className="ckshape">
        <span>
          <span className="ckrn">Draft length</span>
          <span className="ckrd">
            {slots.length} starting slots · {Math.max(0, d.rounds - slots.length)} bench
          </span>
        </span>
        <span className="ckstep">
          <button aria-label="One round fewer" disabled={d.rounds <= slots.length}
            onClick={() => setRounds(d.rounds - 1)}>−</button>
          <b>{d.rounds}</b>
          <button aria-label="One round more" onClick={() => setRounds(d.rounds + 1)}>+</button>
        </span>
      </div>
      )}

      {/*
        * Before a draft, opening the board is the whole reason to be here and
        * it gets the space. Afterwards the draft is history: a full-width
        * action for reading old news crowds out the thing that actually wants
        * doing this week, so it shrinks to a link in the header.
        */}
      {/*
        * The board is a desktop screen: two hundred ranked players, a clock, a
        * verdict column and a roster strip, all of it read at a glance while a
        * timer runs. It does not become a phone screen by being made narrower,
        * and hiding it here would only raise the question of where it went. So
        * on a phone it says what it is and where to open it.
        */}
      {d.preDraft ? (
        <>
          <a className="ckbig-action deskonly" href={`/draft?league=${d.id}`}>
            Open draft companion
            <span className="ckbaz">the board, the verdict and the clock</span>
          </a>
          <div className="ckdesknote">
            <b>The draft board is a laptop screen.</b>
            <span>
              Two hundred ranked players, the clock and the verdict at once — open this
              league on your laptop when the draft starts. This screen keeps the
              countdown, the slot and the roster.
            </span>
          </div>
        </>
      ) : d.drafts[0]?.key ? (
        <a className="cksmall-action" href={`/draft?review=${d.drafts[0].key}`}>
          Review this draft ›
        </a>
      ) : null}

      {/*
        * One box for everything that wants doing, or none at all.
        *
        * A designation, a ruled-out starter and points on the bench were three
        * separate treatments in three places — a tick row, a panel, and a tag
        * you had to notice. They are one question: is there anything to do
        * here? Asked once, at the top, in the only place a glance lands.
        */}
      {!!d.needs?.length && (
        <div className={`ckneeds ${d.needs.some((n) => n.consequence >= 80) ? 'urgent' : ''}`}>
          <div className="ckneedsh">
            {d.needs.length === 1 ? 'One thing needs you' : `${d.needs.length} things need you`}
          </div>
          {d.needs.map((n) => {
            const when = n.deadline
              ? new Date(n.deadline).toLocaleString(undefined,
                  { weekday: 'short', hour: 'numeric', minute: '2-digit' })
              : null
            /* For a draft the deadline is the thing itself, so it belongs in
               the sentence rather than under it — "by Sun 8:30 PM" beneath
               "about 30 minutes before" said the same time twice. */
            const inline = n.rule === 'draft-imminent' && when
            return (
              <div className="ckneed" key={n.rule + n.headline}>
                <b>{n.headline}</b>
                {/*
                  * The deadline finishes the sentence rather than starting a
                  * line of its own under it: "Start X over Y at LB. / by Sun
                  * 10:00 AM" read as two statements, and the second one was a
                  * fragment.
                  */}
                <span>{inline
                  ? `${n.detail} your ${when} draft.`
                  : when ? `${n.detail.replace(/\.$/, '')} by ${when}.` : n.detail}</span>
                {n.rule === 'starter-questionable' && (() => {
                  const plan = d.roster?.pivots?.find((p) => p.playerId === n.playerId)
                  return plan ? <PivotLine plan={plan} /> : null
                })()}

              </div>
            )
          })}
        </div>
      )}

      {/* The full swap list sits below the callout when there is one, and at
          the top when the callout is empty but the lineup can still improve.
          Gated on swaps alone, this hid every close call: a coin flip produces
          no swap by definition, so the one card written to explain it never
          mounted. */}
      {d.roster?.advice &&
        (d.roster.advice.swaps.length > 0 ||
          (d.roster.advice.closeCalls?.length ?? 0) > 0) && (
        <Advice advice={d.roster.advice} />
      )}
      {d.guillotine && <Survival c={d.guillotine} live={!!d.matchup?.started} />}
      {d.matchup && (
        <>
          <div className="cksect">
            {/* In a guillotine week the other name Yahoo prints is the chopping block. */}
            Week {d.matchup.week} · {d.guillotine ? 'your lineup' : d.matchup.opponent}
            <span className="cksecthint">
              {/* Whose numbers these are, said outright. The label read
                  "Sleeper projections" on every league, including the three
                  that take their numbers from Yahoo. */}
              {d.matchup.started
                ? ' — live'
                : ` — ${d.roster?.projectionSource ?? 'projected'} projections${
                    d.roster?.projectionSource === 'Sleeper' ? ', half PPR' : ''}`}
              {d.roster?.advice && d.roster.advice.swaps.length === 0 && (
                /*
                 * "Best lineup you can field" is a claim about a decision, and
                 * once the games start it is a claim about a decision that has
                 * closed. It went on saying it all Sunday, and the lock made it
                 * worse rather than better: with every played slot frozen, the
                 * optimiser cannot propose a change, so the sentence became
                 * trivially true and said nothing at all.
                 *
                 * What is worth knowing mid-week is how much of the lineup you
                 * could still move if you wanted to.
                 */
                (() => {
                  const mine = d.matchup?.mine ?? []
                  const open = mine.filter((x) => x.game === 'pre').length
                  const say =
                    !d.matchup?.started || !mine.length ? 'best lineup you can field'
                    : open === 0 ? 'every slot has kicked off'
                    : `best of what is left · ${open} of ${mine.length} still to play`
                  return <span className="ckoptimal">{' · '}{say}</span>
                })()
              )}
            </span>
          </div>
          <div className="ckvs">
            {!d.guillotine && (() => {
              /*
               * His side, where it arrived with no projections: Yahoo's API
               * publishes none per player, so a man still to play shows a dash
               * rather than a number invented from somebody else's model.
               */
              const filledHis = d.matchup!.theirs.some((x) => x.projectedFrom === 'Sleeper')
              const waiting = d.matchup!.theirs.some((x) => x.game !== 'playing' && x.game !== 'done')
              return filledHis && waiting
                ? <div className="ckvsnote">Yahoo publishes his total but not his players' projections, so his are Sleeper's, marked <i className="ckprojs">s</i>.</div>
                : null
            })()}
            {/*
              * Once the ball is in the air, every number in this header is the
              * live one. The totals switched and the margin between them did
              * not, so the strip read "live" over a projected margin — and the
              * side highlighted as ahead was the side projected to be ahead,
              * which on a Sunday afternoon is the wrong team.
              */}
            {!d.guillotine && (() => {
              const mine = d.matchup!.started ? d.matchup!.live.mine : d.matchup!.projected.mine
              const theirs = d.matchup!.started ? d.matchup!.live.theirs : d.matchup!.projected.theirs
              /*
               * Pace, and on my own side of the header.
               *
               * It only ever describes my players — the opponent arrives as a
               * total with no lineup behind it — so a strip of its own, with
               * the verdict pushed to the right margin, put it next to his
               * name and read as a claim about him.
               */
              const done = d.matchup!.mine.filter(
                (x) => x.game === 'done' && x.points != null && x.projected != null)
              const got = done.reduce((a, x) => a + x.points!, 0)
              const due = done.reduce((a, x) => a + x.projected!, 0)
              const delta = got - due
              // No baseline, no verdict: "ahead of pace" of nought is
              // arithmetic rather than a reading.
              const pace = d.matchup!.started && done.length && due > 0
              const level = Math.abs(delta) < 1
              return (
                <div className="ckvshead">
                  <span>
                    <span className={`ckvsn ${theirs == null || mine >= theirs ? 'up' : ''}`}>
                      {mine.toFixed(1)}
                    </span>
                    <span className="ckvslb">you</span>
                    {/* Where the week was expected to land. Once the games
                        start the header switches wholly to live numbers, and
                        a score with nothing to measure it against says very
                        little — 4.1 is either a disaster or a man who has
                        touched the ball twice. */}
                    {d.matchup!.started && (
                      <span
                        className="ckvspr"
                        title={pace
                          ? `${done.length} of ${d.matchup!.mine.length} done · ${got.toFixed(1)} scored against ${due.toFixed(1)} projected`
                          : undefined}
                      >
                        of {d.matchup!.projected.mine.toFixed(1)} projected
                        {pace && (
                          <span className={`ckvsvd ${level ? '' : delta > 0 ? 'up' : 'down'}`}>
                            {' · '}
                            {level
                              ? 'on pace'
                              : `${Math.abs(delta).toFixed(1)} ${delta > 0 ? 'ahead of' : 'behind'} pace`}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="ckvsm">
                    {d.matchup!.started ? 'live' : 'projected'}
                    {/* A margin needs both halves. Where the other one was
                        never stated this shows a dash rather than subtracting
                        from a nought it did not read. */}
                    <em>
                      {theirs == null
                        ? '—'
                        : `${mine > theirs ? '+' : ''}${(mine - theirs).toFixed(1)}`}
                    </em>
                    {/* What the margin is worth given what is left to play —
                        six up with a quarterback to come is not six up on
                        Monday night. Rounded, because the spread behind it is
                        a measured average rather than this man's own. */}
                    {d.matchup!.win != null && (
                      <i className={`ckvswin ${d.matchup!.win >= 0.5 ? 'up' : 'down'}`}
                         title="From the margin and how much is still to play">
                        {chanceWords(d.matchup!.win)}
                      </i>
                    )}
                  </span>
                  <span className="r">
                    <span className={`ckvsn ${theirs != null && theirs > mine ? 'up' : ''}`}>
                      {theirs == null ? '—' : theirs.toFixed(1)}
                    </span>
                    <span className="ckvslb">{d.matchup!.opponent}</span>
                    {d.matchup!.started && d.matchup!.projected.theirs != null && (
                      <span className="ckvspr">of {d.matchup!.projected.theirs.toFixed(1)} projected</span>
                    )}
                  </span>
                </div>
              )
            })()}
            {/*
              * What is left, as a lineup rather than a count. Sleeper says
              * "yet to play (9) — QB, 2 RB, 3 WR, TE, K, DEF", which tells you
              * where the rest of your week can still come from; a bare nine
              * does not.
              */}
            {(() => {
              const left = (xs: MatchupPlayer[]) => xs.filter((x) => x.game !== 'playing' && x.game !== 'done')
              const shape = (xs: MatchupPlayer[]) => {
                const by = new Map<string, number>()
                for (const x of left(xs)) {
                  const k = x.slot || x.pos || '—'
                  by.set(k, (by.get(k) ?? 0) + 1)
                }
                return [...by].map(([k, n]) => (n > 1 ? `${n} ${k}` : k)).join(', ')
              }
              const mineLeft = left(d.matchup!.mine)
              const theirsLeft = left(d.matchup!.theirs)
              if (!mineLeft.length && !theirsLeft.length) return null
              return (
                <div className="ckyet">
                  <span>
                    <b>yet to play ({mineLeft.length})</b>
                    <em>{shape(d.matchup!.mine)}</em>
                  </span>
                  {!d.guillotine && d.matchup!.theirs.length > 0 && (
                    <span className="r">
                      <b>yet to play ({theirsLeft.length})</b>
                      <em>{shape(d.matchup!.theirs)}</em>
                    </span>
                  )}
                </div>
              )
            })()}
            {/*
              * What the colours mean, said once. The panel codes every number
              * by how far through its game the man is, and a code nobody is
              * told is just an inconsistency — which is exactly how this one
              * read before it was explained.
              */}
            <div className="ckvskey">
              <span className="k toplay">to play</span>
              <span className="k live">playing</span>
              <span className="k final">final</span>
              <em>bold is ahead in the slot</em>
            </div>
            {/* His lineup, checked the way mine is: a starter who cannot score. */}
            {!d.guillotine && d.matchup.theirBroken && (
              <div className="ckvsnote broken">{d.matchup.theirBroken.why}</div>
            )}
            {d.matchup.mine.map((p, i) => {
              /*
               * Yahoo no longer serves a page with the other manager's players
               * on it, so this is a single column of my own under a scoreline
               * that still has both halves. A column of em dashes opposite
               * every name would say less than nothing.
               */
              const solo = d.matchup!.theirs.length === 0 || !!d.guillotine
              const q = solo ? undefined : d.matchup!.theirs[i]
              /*
               * Each row reports its own state, not the week's.
               *
               * The panel used to switch wholesale: the moment any game began
               * it showed points for everybody, so eight men who had not
               * kicked off showed an em dash where their projection had been.
               * It threw away the only number they had, and it did it at
               * exactly the moment the week became interesting.
               *
               * So a man still to play shows what he is expected to do, and a
               * man who has started shows what he has done — with what he was
               * due on the number's own title, because four points means
               * nothing until you know whether eleven were expected.
               */
              const under = (x: MatchupPlayer | undefined) =>
                !!x && (x.game === 'playing' || x.game === 'done')
              const shown = (x: MatchupPlayer | undefined) =>
                under(x) ? (x?.points ?? null) : (x?.projected ?? null)
              /*
               * The slot he is filling, or failing that his position. Rows are
               * paired by order rather than by slot — his lineup is a separate
               * reading — so each side says its own rather than one label
               * across the middle claiming to be both.
               */
              const slotOf = (x: MatchupPlayer | undefined) => x?.slot || x?.pos || null
              /*
               * The name again, short, for the narrow screen where two of
               * these face each other across two numbers and two slots. An
               * initial rather than a bare surname because a lineup holds two
               * Smiths often enough to matter; a defence keeps its own, since
               * "Chargers" is the name and "L. Chargers" is nobody.
               */
              const shortName = (x: MatchupPlayer | undefined) => {
                const full = x?.name ?? '—'
                if (!x || full === '—') return full
                const last = surname(full)
                if (/^(DST|DEF)$/i.test(x.pos ?? '')) return last
                const first = full.trim().split(/\s+/)[0] ?? ''
                return first && last !== first ? `${first[0]}. ${last}` : last
              }
              /*
               * Which of the three numbers a row is showing, per man rather
               * than per row. The row already marked itself live or settled,
               * but a row holds two men and they are rarely in the same state:
               * with mine finished and his not yet kicked off, the row counted
               * as not started and my real score was printed in the same grey
               * as his projection. A score and a guess are not the same claim
               * and should not look alike.
               */
              const state = (x: MatchupPlayer | undefined) =>
                x?.game === 'done' ? 'final' : x?.game === 'playing' ? 'live' : 'toplay'
              const saidAs = (x: MatchupPlayer | undefined) => {
                const proj = x?.projected != null ? `projected ${x.projected.toFixed(1)}` : 'no projection published'
                return x?.game === 'done' ? `Final \u00b7 ${proj}`
                  : x?.game === 'playing' ? `Scored so far, still playing \u00b7 ${proj}`
                  : 'Projected — his game has not kicked off'
              }
              /*
               * A row is only won with a number on both sides of it. His men
               * arrive without projections, and a dash read as nought handed
               * me every slot he had not played yet, arrows and all.
               */
              const both = shown(p) != null && shown(q) != null
              const mineWins = both && shown(p)! >= shown(q)!
              const theirsWins = both && shown(q)! > shown(p)!
              const gap = both ? Math.abs(shown(p)! - shown(q)!) : 0
              /*
               * A light edge while that man's game is actually running, so the
               * rows still moving separate from the ones already settled and
               * the ones that have not begun. Deliberately faint: it marks a
               * state, it does not ask for anything.
               */
              const onField = p?.game === 'playing' || q?.game === 'playing'
              /*
               * And faded once every game on the row is over. Those numbers
               * are final: nothing about them is a decision any more, so they
               * step back and leave the rows still in play to the eye.
               */
              const settled =
                !onField &&
                (p ? p.game === 'done' : true) && (q ? q.game === 'done' : !p || p.game === 'done')
              return (
                <div
                  className={`ckvsrow${solo ? ' ckvsone' : ''}${onField ? ' playing' : ''}${settled ? ' played' : ''}`}
                  key={p?.id ?? i}
                  title={onField ? 'Playing now' : settled ? 'Played — his week is over' : undefined}
                >
                  {/*
                    * Names outside, numbers inside. The two figures being
                    * compared were at opposite edges of the row with both
                    * names between them, so reading a slot meant crossing the
                    * card twice; set against the middle they sit a
                    * centimetre apart and the wider one is obvious.
                    */}
                  <span className={`ckvsp ${state(p)} ${!solo && mineWins ? 'lead' : ''}`}>
                    <span className="ckvsnm">
                      {slotOf(p) && <span className="ckvspos">{slotOf(p)}</span>}
                      <span className="ckvsnmt">
                        <span className="full">{p?.name ?? '—'}</span>
                        <span className="short">{shortName(p)}</span>
                      </span>
                      {p?.injuryStatus && (
                        <InjuryTag status={p.injuryStatus} body={p.injuryBody} practice={p.practice}
                                   severity={p.severity} why={p.why} rate={p.playRate}
                                   pending={p.reportPending} />
                      )}
                    </span>
                    {/*
                      * What he got, once he has played. The projection stays as
                      * the row's title rather than beside the score: a man who
                      * has finished has a number, and "19.0 of 10.2" made the
                      * finished rows the busiest thing on the page.
                      */}
                    <span className={`ckvsval ${state(p)}`} title={saidAs(p)}>
                      <em>{shown(p) != null ? shown(p)!.toFixed(1) : '—'}</em>
                      {!under(p) && p?.projectedFrom === 'Sleeper' && d.roster?.projectionSource === 'Yahoo' && (
                        <i className="ckprojs" title="Yahoo publishes no projection for him — this is Sleeper's, scored your league's way">s</i>
                      )}
                    </span>
                  </span>
                  {!solo && (
                    <>
                      {/* Where the week is actually decided: the widest slot. */}
                      <span className={`ckvsgap ${gap >= 5 ? 'big' : ''}`}>{gap >= 5 ? (mineWins ? '\u25c0' : '\u25b6') : '·'}</span>
                      <span className={`ckvsp r ${state(q)} ${theirsWins ? 'lead' : ''}`}>
                        <span className="ckvsnm">
                          {slotOf(q) && <span className="ckvspos">{slotOf(q)}</span>}
                          <span className="ckvsnmt">
                            <span className="full">{q?.name ?? '—'}</span>
                            <span className="short">{shortName(q)}</span>
                          </span>
                          {q?.injuryStatus && (
                            <InjuryTag status={q.injuryStatus} body={q.injuryBody} practice={q.practice}
                                       severity={q.severity} why={q.why} rate={q.playRate}
                                       pending={q.reportPending} />
                          )}
                        </span>
                        <span className={`ckvsval ${state(q)}`} title={saidAs(q)}>
                          <em>{shown(q) != null ? shown(q)!.toFixed(1) : '—'}</em>
                          {!under(q) && q?.projectedFrom === 'Sleeper' && d.roster?.projectionSource === 'Yahoo' && (
                            <i className="ckprojs" title="Yahoo publishes no projection for him — this is Sleeper's, scored your league's way">s</i>
                          )}
                        </span>
                      </span>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {d.waivers && d.waivers.targets.length > 0 && <Wire w={d.waivers} />}

      {/*
        * Projected points without an opponent. Yahoo will not say who you are
        * playing, so there is no head-to-head — but the total is still the
        * number you are trying to make large, and it belongs on the screen.
        */}
      {!d.matchup && d.roster?.projectedTotal != null && (
        <>
          <div className="cksect">
            Week {d.roster.week} · projected
            <span className="cksecthint">
              {` — ${d.roster.projectionSource}'s own projections`}
              {/* Where a number came from somewhere else, the card says so. */}
              {!!d.roster.projectionCoverage?.filled &&
                `, ${d.roster.projectionCoverage.filled} filled from Sleeper`}
              {d.roster.projectionCoverage &&
                d.roster.projectionCoverage.counted + (d.roster.projectionCoverage.filled ?? 0)
                  < d.roster.projectionCoverage.of &&
                `, ${d.roster.projectionCoverage.counted} of ${d.roster.projectionCoverage.of} players read`}
            </span>
          </div>
          <div className="ckvs">
            <div className="ckvshead">
              <span>
                <span className="ckvsn up">{d.roster.projectedTotal.toFixed(1)}</span>
                <span className="ckvslb">your starters</span>
              </span>
              <span className="ckvsm">
                bench
                <em>
                  {bench.reduce((a, p) => a + (p.projected ?? 0), 0).toFixed(1)}
                </em>
              </span>
              <span className="r">
                <span className="ckvsn">{lineup.filter((p) => p.projected != null).length}/{lineup.length}</span>
                <span className="ckvslb">starters read</span>
              </span>
            </div>
          </div>
        </>
      )}

      <div className="cksect">
        Roster
        {byeWeek != null && (
          <span className="cksecthint">
            {' — '}
            {[...lineup, ...bench].filter((p) => p.byeWeek === byeWeek).length} away in week {byeWeek}
          </span>
        )}
      </div>
      {!d.connected && <div className="ckph"><div className="ckphk">No feed</div><p>{d.blocked}</p></div>}
      {d.connected && !d.roster?.players.length && (
        <div className="ckph">
          <div className="ckphk">Empty</div>
          <div className="ckpht">{slots.length} starting slots, {d.benchSize} bench</div>
          <p>Nothing rostered — this league drafts {d.draftTime ? new Date(d.draftTime).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : 'soon'}.</p>
          <p className="ckphn"><b>Slots:</b> {slots.join(' · ')}</p>
        </div>
      )}
      {d.connected && !!d.roster?.players.length && (
        <div className="ckroster">
          {[...lineup, ...bench].map((p) => (
            /* Dimmed rather than hidden when a bye week is being inspected:
               who is left matters as much as who is away. */
            <div
              className={`ckslot ${p.starter ? '' : 'bench'}` +
                (byeWeek == null ? '' : p.byeWeek === byeWeek ? ' away' : ' faded')}
              key={p.id}
            >
              <span className={`ckpos ${p.pos ?? ''}`}>{p.starter ? p.pos : 'BN'}</span>
              <span>
                <span className="cksn">{p.name}
                  {p.injuryStatus && (
                    <InjuryTag status={p.injuryStatus} body={p.injuryBody} practice={p.practice}
                               severity={p.severity} why={p.why} rate={p.playRate} pending={p.reportPending} />
                  )}
                </span>
                <span className="ckproj">
                  {p.projected != null ? p.projected.toFixed(1) : '—'}
                  {/* Yahoo printed none for him, so this is Sleeper's, scored
                      this league's way. Marked rather than blended silently. */}
                  {p.projectedFrom === 'Sleeper' && d.roster?.projectionSource === 'Yahoo' && (
                    <i className="ckprojs" title="Yahoo printed no projection for him — this is Sleeper's, scored your league's way">s</i>
                  )}
                </span>
              <span className="cksd">
                  {p.team}{p.opponent ? ` vs ${p.opponent}` : ''}<DefenceRank p={p} /> · bye {p.byeWeek ?? '—'}
                  <GameWx w={p.weather} />
                  <CoverageTag c={p.coverage} />
                  {p.matchupNote && <span className="ckmatch">{p.matchupNote}</span>}
                  {/* The tag says questionable; this says what the week looked like. */}
                  <PracticeLine p={p} />
                  <TakeChips takes={p.takes} />
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/*
        * Byes last, because they are planning rather than a decision.
        * Between the advice and the lineup they took the eye on the way past —
        * a coloured strip of week numbers outpulls a list of names, and the
        * list of names is what you came for.
        */}
      {d.byes && d.byes.length > 0 && (
        <>
          <div className="cksect">
            Byes ahead
            <span className="cksecthint">
              {byeWeek
                ? ` — showing who is away in week ${byeWeek}; tap again to clear`
                : ' — tap a week to see who is away'}
            </span>
          </div>
          <div className="ckbyes">
            {d.byes.slice(0, 6).map((b) => {
              /* Three names, then a count. A bye that empties six slots is one
                 fact — "this week is a write-off" — and listing all six reads
                 as six problems while making the tile unreadable. */
              const shown = b.shortfalls.slice(0, 3).map((s) => s.slot)
              const rest = b.shortfalls.length - shown.length
              const on = byeWeek === b.week
              /* Amber where the week is actually a problem — a slot that cannot
                 be filled, or enough men away that it will be. One player on a
                 bye is a fact; three, or a hole, is a week to plan for. */
              const rough = b.shortfalls.length > 0 || b.away > 2
              return (
                <button
                  className={`ckbye ${rough ? 'bad' : ''} ${on ? 'on' : ''}`}
                  key={b.week}
                  aria-pressed={on}
                  onClick={() => setByeWeek(on ? null : b.week)}
                >
                  <b>Week {b.week}</b>
                  <span>{b.away} away</span>
                  <em>
                    {b.shortfalls.length
                      ? `cannot fill ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
                      : 'still able to field a lineup'}
                  </em>
                </button>
              )
            })}
          </div>
        </>
      )}


      {!!d.startSit?.weeks.length && <StartSit s={d.startSit} />}
      {!!d.moves?.length && <Moves moves={d.moves} />}
      {d.allPlay && d.allPlay.table.length > 1 && <Luck a={d.allPlay} />}

      {d.preDraft && !!d.drafts.length && (
        <>
          <div className="cksect">
            Past drafts
            {d.drafts.some((r) => !r.exact) && (
              <span className="cksecthint"> — mocks are matched by shape; Yahoo never says which league you launched from</span>
            )}
          </div>
          <div className="ckgrid">
            {d.drafts.map((r) => (
              <a className={`ck ${r.exact ? 'quiet' : 'knowing'}`} key={r.key} href={`/draft?review=${r.key}`}>
                <div className="ckhead">
                  <span className="cknm sm">{new Date(r.at).toLocaleDateString()}</span>
                  <span className="ckfmt">{r.teams}tm · {r.rounds}rd</span>
                </div>
                <div className="ckwhy">
                  {r.picks} picks · slot {r.mySlot ?? '—'}{r.exact ? '' : ' · mock'}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/* ------------------------------------------------- league-wide, from Yahoo */

const tally = (t: Tally) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`

/*
 * A guillotine week: where I stand, and who is nearest the block.
 *
 * The bottom three by projection, because that is the question a guillotine
 * asks every Sunday — and my own row among them when I am in it, which is the
 * one time this panel should be hard to miss.
 */
function Survival({ c, live }: { c: Chop; live: boolean }) {
  const lowest = c.bottom[c.bottom.length - 1]
  return (
    <>
      <div className="cksect">
        Week {c.week ?? ''} · survival
        <span className="cksecthint"> — {c.of} teams left, ranked by live projection; the lowest score is cut
          {/* Its age only when it has one worth saying: the API reads it every ten minutes on a Sunday. */}
          {Date.now() - c.at > 45 * 60_000 && ` · as of ${agoWords(new Date(c.at).toISOString())}`}
        </span>
      </div>
      <div className="ckvs">
        <div className="ckvshead">
          <span>
            <span className={`ckvsn ${c.onTheBlock ? 'down' : c.place > c.of - 3 ? 'risk' : 'up'}`}>
              {ordinal(c.place)}
            </span>
            <span className="ckvslb">of {c.of} by projection</span>
            <span className="ckvspr">
              {live && c.points != null ? `${c.points.toFixed(1)} so far · ` : ''}projected {c.projected?.toFixed(1) ?? '—'}
            </span>
          </span>
          <span className="ckvsm">
            {c.onTheBlock ? 'below' : 'clear'}
            <em>{c.cushion == null ? '—' : `${c.cushion >= 0 ? '+' : '−'}${Math.abs(c.cushion).toFixed(1)}`}</em>
          </span>
          <span className="r">
            <span className="ckvsn">{lowest?.projected != null ? lowest.projected.toFixed(1) : '—'}</span>
            <span className="ckvslb">lowest projected</span>
          </span>
        </div>
        {c.bottom.map((r, i) => {
          /* The line Yahoo draws across its own standings: everybody above it
             survives the week, the team below it is the one being cut. */
          const block = i === c.bottom.length - 1
          return (
            <div key={r.teamId}>
              {block && <div className="ckchopline">death watch</div>}
              <div className={`ckchop${r.mine ? ' mine' : ''}${block ? ' block' : ''}`}>
                <span className="ckchopn">{c.of - c.bottom.length + i + 1}</span>
                <span className="ckchopt">
                  <b>{r.mine ? 'You' : r.name}</b>
                  {!r.mine && <em>{r.manager}</em>}
                </span>
                {/* What he has left to bid with: the chopped team's roster is
                    the best wire of the season, and it goes to the deep pocket. */}
                {r.faab != null && <span className="ckchopf">${r.faab}</span>}
                <span className="ckchopp">
                  {live && r.points != null && <em>{r.points.toFixed(1)} · </em>}
                  {r.projected != null ? r.projected.toFixed(1) : '—'}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/*
 * Free agents who fill a hole, best first. Only holes: wanting a better back
 * is not a waiver move, and a list of everybody available is a search page.
 */
function Wire({ w }: { w: NonNullable<Detail['waivers']> }) {
  return (
    <>
      <div className="cksect">
        On the wire
        <span className="cksecthint">
          {' — '}{w.holes.map((h) => h.reason).join('; ')}
          {w.budget != null && ` · $${Math.max(0, w.budget - (w.spent ?? 0))} FAAB left`}
        </span>
      </div>
      <div className="ckexp">
        {w.targets.map((t) => (
          <div className="ckexprow" key={t.id}>
            <span className="ckexpn">
              {t.name}
              <em className="ckexpsub">{t.pos}{t.team ? ` · ${t.team}` : ''}</em>
            </span>
            <span className="ckexpl">
              <span className={t.onWaivers ? '' : 'on'}>{t.onWaivers ? 'on waivers' : 'free agent'}</span>
              <span>fills {t.fills}</span>
            </span>
            <span className="ckexpp">{t.projected != null ? t.projected.toFixed(1) : '—'}</span>
          </div>
        ))}
      </div>
    </>
  )
}

const MOVE_KIND: Record<string, string> = {
  'dropped-worth-having': 'free now',
  'rival-filling-my-hole': 'at your hole',
  'touched-mine': 'yours elsewhere',
}

/* What the rest of the league did, filtered to what bears on me. */
function Moves({ moves }: { moves: NonNullable<Detail['moves']> }) {
  return (
    <>
      <div className="cksect">
        Around the league
        <span className="cksecthint"> — only the moves that bear on you</span>
      </div>
      <div className="ckexp">
        {moves.map((m) => (
          <div className="ckexprow" key={`${m.move.id}-${m.player.id}`}>
            <span className="ckexpn">{m.headline}</span>
            <span className="ckexpl"><span>{MOVE_KIND[m.kind] ?? m.kind}</span></span>
            <span className="ckexpp">{agoWords(new Date(m.move.at).toISOString())}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/*
 * The record, separated from the draw: what it is, what it would be against
 * everybody every week, and the difference in games, which is the part nobody
 * chose. Where you go to look rather than where you are told, so it sits low.
 */
function Luck({ a }: { a: NonNullable<Detail['allPlay']> }) {
  const me = a.mine
  const words = (g: number | null) =>
    g == null ? '' : Math.abs(g) < 0.25 ? 'about what you earned'
    : g > 0 ? `${g.toFixed(1)} ${Math.abs(g) >= 0.95 && Math.abs(g) < 1.05 ? 'win' : 'wins'} of luck`
    : `${Math.abs(g).toFixed(1)} ${Math.abs(g) >= 0.95 && Math.abs(g) < 1.05 ? 'win' : 'wins'} unlucky`
  const tone = (g: number | null) => (g == null || Math.abs(g) < 0.25 ? '' : g > 0 ? 'up' : 'down')
  return (
    <>
      <div className="cksect">
        Luck
        <span className="cksecthint"> — as played, against the whole league every week, and the difference</span>
      </div>
      {me && (
        <div className="ckluck">
          <span><b>{tally(me.actual)}</b><em>as played</em></span>
          <span><b>{tally(me.deserved)}</b><em>against everyone</em></span>
          <span className={tone(me.games)}><b>{me.games == null ? '—' : `${me.games > 0 ? '+' : ''}${me.games.toFixed(1)}`}</b><em>{words(me.games) || 'no games yet'}</em></span>
        </div>
      )}
      <div className="ckexp">
        {a.table.map((r) => (
          <div className={`ckexprow${r.teamId === me?.teamId ? ' mine' : ''}`} key={r.teamId}>
            <span className="ckexpn">{r.teamId === me?.teamId ? 'You' : r.manager}</span>
            <span className="ckexpl">
              <span>{tally(r.actual)} played</span>
              <span>{tally(r.deserved)} all-play</span>
            </span>
            <span className={`ckexpp ckluckg ${tone(r.games)}`}>
              {r.games == null ? '—' : `${r.games > 0 ? '+' : ''}${r.games.toFixed(1)}`}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

/*
 * The weeks already played, graded against the lineup hindsight would have
 * set. Sleeper prints the percentage beside your name and stops there, which
 * is the least useful half: the number is only worth having with the weeks
 * under it, because "94%" is not a thing you can do anything about and
 * "Warren for Black at the flex, nine points" is.
 */
function StartSit({ s }: { s: NonNullable<Detail['startSit']> }) {
  const pc = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`)
  const weeks = [...s.weeks].sort((a, b) => b.week - a.week)
  return (
    <>
      <div className="cksect">
        Start/sit
        <span className="cksecthint"> — against the best lineup that bench could have made, knowing how it turned out</span>
      </div>
      {/*
        * No red on any of it. Every number here is hindsight, and points left
        * on a bench are not a failing the way a lost game is — nobody could
        * have started the man who went for twenty-eight on four targets. A
        * week that could not have been improved gets the green, because that
        * one is unambiguous; the rest are left to be read rather than judged.
        */}
      <div className="ckluck">
        <span><b>{pc(s.share)}</b><em>of the perfect lineup</em></span>
        <span><b>{s.left.toFixed(1)}</b><em>left on the bench</em></span>
        <span><b>{weeks.length}</b><em>{weeks.length === 1 ? 'week played' : 'weeks played'}</em></span>
      </div>
      <div className="ckexp ckss">
        {weeks.map((w) => (
          <div className="ckexprow" key={w.week}>
            <span className="ckexpn">Week {w.week}</span>
            <span className="ckexpl">
              <span>{w.actual.toFixed(1)} of {w.perfect.toFixed(1)}</span>
              <span>
                {w.missed.length
                  ? w.missed.map((m) => `${m.in} for ${m.out} at ${m.slot} +${m.gain.toFixed(1)}`).join(' · ')
                  : 'nothing better on the bench'}
              </span>
            </span>
            <span className={`ckexpp ckluckg ${w.share === 1 ? 'up' : ''}`}>{pc(w.share)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/* ---------------------------------------------------------- notifications */

function Alerts({ data, onRead }: {
  data: { notes: Note[]; events: Ev[]; lastPollAt: number | null; lastPollOk: boolean; lastPollError: string | null }
  onRead: () => void
}) {
  const unread = data.notes.filter((n) => !n.read)
  return (
    <>
      <Head
        big={unread.length ? `${unread.length} to see` : data.notes.length ? 'All caught up' : 'Nothing has woken you'}
        sub={data.lastPollAt
          ? `Checked ${agoWords(new Date(data.lastPollAt).toISOString())}${data.lastPollOk ? '' : ' · last check failed'}`
          : 'First check has not run yet'}
      />
      {!data.lastPollOk && data.lastPollError && (
        <p className="cknote dim">The last check failed: {data.lastPollError}</p>
      )}
      {!!unread.length && (
        <button className="ckreadall" onClick={onRead}>Mark all read</button>
      )}
      <div className="ckgrid">
        {data.notes.map((n) => (
          <div className={`ck ${n.read ? 'blocked' : 'act'}`} key={n.id}>
            <div className="ckhead"><span className="cknm sm">{n.title}</span></div>
            <div className="ckwhy">{n.body}</div>
            <div className="ckfoot">
              <span className={`ckpill ${n.read ? 'blocked' : 'act'}`}>{n.rule}</span>
              <span className="cksp" />
              <span className="ckfresh">{agoWords(new Date(n.at).toISOString())}</span>
            </div>
          </div>
        ))}
        {!data.notes.length && (
          <div className="ckph">
            <div className="ckphk">Working as intended</div>
            <div className="ckpht">Nothing has met the bar</div>
            <p>A notification needs a fact that changed, a consequence on a roster you hold, and a
              deadline. Most weeks nothing qualifies — and a tool willing to stay quiet is the only
              kind worth trusting when it does speak.</p>
          </div>
        )}
      </div>
      <div className="cksect">Everything that changed</div>
      <div className="ckroster">
        {data.events.map((e) => (
          <div className="ckslot" key={e.id}>
            <span className={`ckpos ${e.pos}`}>{e.pos}</span>
            <span>
              <span className="cksn">{e.name} <span className="ckdim">{e.from} → {e.to}</span></span>
              <span className="cksd">{e.team}{e.body ? ` · ${e.body}` : ''} · {agoWords(new Date(e.at).toISOString())}</span>
            </span>
          </div>
        ))}
        {!data.events.length && <div className="ckempty">Nothing has changed since the first snapshot.</div>}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- news */

const GROUPS: { id: Group; label: string; blurb: string }[] = [
  { id: 'needs', label: 'Needs you', blurb: 'Your player got worse' },
  { id: 'opening', label: 'An opening', blurb: "Someone else's starter is out and the replacement is free" },
  { id: 'knowing', label: 'Worth knowing', blurb: 'Yours, but nothing to do yet' },
  { id: 'rising', label: 'Rising', blurb: 'Promoted, or the market is moving on him' },
]

/**
 * A designation with what is known behind it. The native tooltip said
 * "Undisclosed", which is the body part and not the story — this carries
 * Sleeper's note where it exists, the headline that names the player, and a way
 * out to the news when neither does.
 */
function InjuryTag({ status, body, practice, severity, why, rate, pending }: {
  status: string; body?: string | null; practice?: string | null
  severity?: string | null; why?: Why | null
  rate?: PlayRate | null; pending?: boolean | null
}) {
  return (
    <span className="ckinjwrap">
      <span
        className={`ckinj ${severity ?? 'coin-flip'}`}
        tabIndex={0}
        role="button"
        aria-label={`${status}${body ? `, ${body}` : ''} — what is known`}
      >
        {status === 'Questionable' ? 'Q' : status}
      </span>
      <span className="ckinjcard">
        <span className="ckics">{status}{body ? ` · ${body}` : ''}</span>
        {practice && <span className="ckicp">{practice.replace(/ i?n Practice$/i, '')}</span>}
        {rate && <span className="ckicr">Plays {pct(rate)} — {rateSaid(rate, pending)}</span>}
        {why?.note && <span className="ckicn">{why.note}</span>}
        {why?.headline && <span className="ckich">{why.headline}</span>}
        {!why?.headline && !why?.note && <span className="ckicn dim">No note published</span>}
        {why?.link && (
          <a className="ckicl" href={why.link} target="_blank" rel="noreferrer noopener">
            {why.headline ? 'Read it ›' : 'Search the news ›'}
          </a>
        )}
      </span>
    </span>
  )
}

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null
  return (
    <div className="ckchips">
      {chips.map((c) => (
        <span key={c.leagueId} className={`ckchip ${c.tone}`}>{c.label} · {c.note}</span>
      ))}
    </div>
  )
}

/*
 * Form carries priority, not just grouping. A card is for something that needs
 * a decision; twenty-three cards saying "is being picked up" is a wall whatever
 * heading sits above it. The market is scannable data, so it gets rows.
 */
function RisingRow({ i }: { i: Item }) {
  const free = i.chips.filter((c) => c.tone === 'free').length
  const move = /\+([\d,]+) since/.exec(i.detail)?.[1] ?? null
  const meta = i.detail.replace(/ · \+[\d,]+ since the last check/, '')
  return (
    <div className="ckrise">
      <span>
        <span className="ckrn2">
          {i.headline.replace(/ is being picked up| moves to first on the depth chart/, '')}
          {/* The practice week, where the report has one — the tag alone
              cannot separate a precaution from a problem. */}
          {i.practice && (
            <span className={`ckprac ${i.practice.severity}`} title={i.practice.status}>
              {' '}{i.practice.status.replace(/ i?n Practice$/i, '')
                .replace('Did Not Participate', 'DNP')
                .replace('Limited Participation', 'limited')
                .replace('Full Participation', 'full')}
            </span>
          )}
        </span>
        {/* The number is the alarm; this is the reason for it. */}
        {i.because && <span className="ckwhy2">{i.because}</span>}
      </span>
      <span className="ckrm">{meta.split(' · ')[0]}</span>
      <span className="ckrd2">{move ? `+${move}` : '—'}</span>
      <span className={`ckrf ${free ? 'yes' : 'no'}`}>{free ? `free ×${free}` : 'taken'}</span>
    </div>
  )
}

/**
 * One player's news, as a card.
 *
 * Which of your leagues he sits in is the first thing you need and was the
 * hardest thing to read — "Owns +2" in a column, when the leagues already have
 * names and colours everywhere else in the app.
 */
function NewsCard({ i, own }: { i: Item; own: boolean }) {
  const meta = (i.detail ?? '').split(' · ')
  return (
    <div className={`ck cknews ${own ? 'own' : ''}`}>
      <div className="ckhead">
        <span className="cknm sm">{i.headline}</span>
        <span className="cksp" />
        {i.practice && (
          <span className={`ckpill ${i.practice.severity === 'likely-out' ? 'act'
            : i.practice.severity === 'coin-flip' ? 'soon' : 'quiet'}`}>
            {i.practice.status}
          </span>
        )}
      </div>
      <div className="cknewsm">{meta[0]}{meta[1] ? ` · ${meta[1]}` : ''}</div>

      {/* The leagues, in their own colours — the thing you actually scan for. */}
      {!!i.chips.length && (
        <div className="cknewsl">
          {i.chips.map((c) => (
            <span key={c.leagueId} className={`cknewschip ${c.tone}`} style={leagueStyle(c.leagueId)}>
              {c.label}{c.note ? ` · ${c.note}` : ''}
            </span>
          ))}
        </div>
      )}


      {/* A headline without a link is text, not a dead anchor. href="#" shows
          a URL on hover and does nothing when clicked, which is the worst of
          both — it promises somewhere to go and then refuses. */}
      {i.why?.headline && (i.why.link
        ? <a className="cknewsw" href={i.why.link} target="_blank" rel="noreferrer">
            {i.why.headline} ›
          </a>
        : <span className="cknewsw plain">{i.why.headline}</span>
      )}
      {!i.why?.headline && i.because && <div className="cknewsw plain">{i.because}</div>}
    </div>
  )
}

/**
 * News, split by the only question that changes what you do about it: is he
 * mine?
 *
 * It was one table with columns for position, movement and ownership, which
 * asked the reader to decode "Owns +2" and re-derive the distinction for
 * themselves on every row. Your players and everybody else's are different
 * jobs — one is a lineup decision, the other is a shopping list — and they are
 * now two sections of cards in the app's own shape.
 */
function News({ data }: { data: { items: Item[]; watched: number; quiet: number; ignored: number } }) {
  const [all, setAll] = useState(false)
  /*
   * Ownership lives in the chip's note, not in whether there is a chip: a free
   * agent still carries one for every league he is free in. Splitting on the
   * chip's presence put all twenty-five under "yours", which is exactly the
   * thing this section exists to distinguish.
   */
  const owned = (i: Item) => i.chips.some((c) => /starting|yours|bench/i.test(c.note ?? ''))
  const mine = data.items.filter(owned)
  const others = data.items.filter((i) => !owned(i))
  const CAP = 6
  const shown = all ? others : others.slice(0, CAP)
  const roles = (data as any).roles

  return (
    <>
      <Head
        big={mine.length
          ? mine.length === 1
            ? 'One of your players is in the news'
            : `${mine.length} of your players are in the news`
          : 'None of your players are in the news'}
        sub={`${data.watched} of your players watched · ${data.ignored.toLocaleString()} others ignored`
          + ((data as any).practice?.note ? ` · practice report ${(data as any).practice.note}` : '')}
      />

      {!!mine.length && (
        <>
          <div className="cksect">
            Yours
            <span className="cksecthint"> — in a lineup or on a bench of yours</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {mine.map((i) => <NewsCard key={i.id} i={i} own />)}
          </div>
        </>
      )}

      {!!shown.length && (
        <>
          <div className="cksect">
            Worth adding
            <span className="cksecthint"> — moving fastest, and free in at least one of your leagues</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {shown.map((i) => <NewsCard key={i.id} i={i} own={false} />)}
          </div>
          {others.length > CAP && (
            <button className="cksmall-action" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${others.length}`} ›
            </button>
          )}
        </>
      )}

      {/* Roles change days before points do, so it leads the shopping list when
          there is anything to lead it with. Empty until games are played. */}
      {!!roles?.rows?.length && (
        <>
          <div className="cksect">
            Roles changing
            <span className="cksecthint"> — snap and target share, week over week</span>
          </div>
          <div className="ckgrid cknewsgrid">
            {roles.rows.slice(0, 6).map((r: any) => (
              <div className="ck cknews" key={r.name}>
                <div className="ckhead">
                  <span className="cknm sm">{r.name}</span>
                  <span className="cksp" />
                  <span className="ckpill quiet">{r.pos}</span>
                </div>
                <div className="cknewsm">
                  {r.team}
                  {r.snapTrend != null && ` · snaps ${r.snapTrend > 0 ? '+' : ''}${(r.snapTrend * 100).toFixed(0)}%`}
                  {r.targetTrend != null && ` · targets ${r.targetTrend > 0 ? '+' : ''}${(r.targetTrend * 100).toFixed(1)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/*
        * Around the league: the wire itself, unfiltered by whether it touches a
        * roster of yours. Dropped in the rewrite, which was a loss — the first
        * two sections answer "what should I do", and this one answers "what
        * happened", which is a different reason to open a news page.
        */}
      {!!(data as any).wire?.items?.length && (() => {
        /*
         * Two blocks, each honestly newest-first. One list ordered by relevance
         * and then by time reads as broken, because the timestamps are the
         * thing the eye lands on and they go backwards.
         */
        const all = (data as any).wire.items as WireItem[]
        const yours = all.filter((w) => w.mentions.some((m) => m.leagues.length))
        const rest = all.filter((w) => !w.mentions.some((m) => m.leagues.length))
        const card = (w: WireItem, mine: boolean) => (
          <a className={`ckw ${mine ? 'mine' : ''}`} key={w.id} href={w.link}
             target="_blank" rel="noreferrer noopener">
            <span className="ckwt">{w.title}</span>
            {!!w.mentions.length && (
              <span className="ckwm">
                {w.mentions.slice(0, 3).map((m) => m.name).join(' · ')}
                {mine ? ' — yours' : ''}
              </span>
            )}
            <span className="ckws">{w.source} · {agoWords(new Date(w.at).toISOString())}</span>
          </a>
        )
        return (
          <>
            {yours.length > 0 && (
              <>
                <div className="cksect">
                  Your players in the news
                  <span className="cksecthint">{' — '}newest first</span>
                </div>
                <div className="ckwire">{yours.slice(0, 8).map((w) => card(w, true))}</div>
              </>
            )}
            <div className="cksect">
              Around the league
              <span className="cksecthint">
                {' — '}{(data as any).wire.sources.join(', ')}, newest first
              </span>
            </div>
            <div className="ckwire">{rest.slice(0, 10).map((w) => card(w, false))}</div>
          </>
        )
      })()}

      {!mine.length && !others.length && (
        <div className="ckempty">Nothing has moved since the last look.</div>
      )}

      {/* Whose injury calls hold up. Graded against who took a snap; a
          game-time call is an answer rather than a call and is not graded. */}
      {!!(data as any).injuryCalls?.length && (
        <>
          <div className="cksect">
            Injury calls
            <span className="cksecthint"> — graded against who took the field; game-time calls are not graded</span>
          </div>
          <div className="ckcalls">
            <div className="ckcalls-h">
              <span>Analyst</span><span>Right</span><span>Wrong</span><span>Game-time</span><span>Open</span>
            </div>
            {((data as any).injuryCalls as AnalystRecord[]).map((r) => (
              <div className="ckcalls-r" key={r.analyst}>
                <span><b>{r.analyst}</b>, {r.credential} <em>{r.outlet}</em></span>
                <span>{r.right}</span><span>{r.wrong}</span><span>{r.hedged}</span><span>{r.pending}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function NewsTab({ news, alerts, onRead }: { news: any; alerts: any; onRead: () => void }) {
  const [on, setOn] = useState<'News' | 'Alerts'>('News')
  return (
    <>
      <Seg opts={['News', 'Alerts']} on={on} set={setOn} />
      {on === 'News' && (news
        ? <News data={news} />
        : <div className="ckempty">Comparing snapshots…</div>)}
      {on === 'Alerts' && (alerts
        ? <Alerts data={alerts} onRead={onRead} />
        : <div className="ckempty">Reading the log…</div>)}
    </>
  )
}

/* ------------------------------------------------------------------- plan */

function Placeholder({ title, why, needs }: { title: string; why: string; needs: string }) {
  return (
    <div className="ckph">
      <div className="ckphk">Not built yet</div>
      <div className="ckpht">{title}</div>
      <p>{why}</p>
      <p className="ckphn"><b>Waiting on:</b> {needs}</p>
    </div>
  )
}

/**
 * How much of the season rides on one name.
 *
 * You own the same players in more than one league, so a single hamstring can
 * cost three teams at once. Nothing sold commercially can tell you this,
 * because nothing sold commercially sees all four leagues.
 */
/**
 * The number beside a shared name: at stake before his game, and how it is
 * going once it starts.
 *
 * The same honesty rule as the tile's movers. Mid-game, only a swing that is
 * already positive is reported — a man at half time short of his projection is
 * on schedule, not failing, so he shows what he has so far instead of a verdict.
 * Once he is finished, either direction is fair.
 */
function ExposureScore({ e }: { e: any }) {
  if (e.startingIn === 0) return <>bench</>
  const live = e.live
  if (!live) return <>{e.projectedAcross.toFixed(1)} pts</>
  const verdict = live.swing != null && (!live.playing || live.swing > 0)
  if (!verdict) {
    return <span className="ckexplive" title="Still playing">{live.got.toFixed(1)} so far</span>
  }
  const up = live.swing >= 0
  return (
    <span
      className={`ckexplive ${up ? 'up' : 'down'}${live.playing ? ' playing' : ''}`}
      title={`${live.got.toFixed(1)} scored across ${live.leagues} league${
        live.leagues === 1 ? '' : 's'}, ${Math.abs(live.swing).toFixed(1)} ${
        up ? 'over' : 'under'} what he was projected in each`}
    >
      {up ? '+' : '\u2212'}{Math.abs(live.swing).toFixed(1)}
    </span>
  )
}

function Exposure() {
  const [d, setD] = useState<any>(null)
  /*
   * On the same half-minute beat as the tiles. This fetched once when the page
   * opened and never again, so on a home screen left up through a Sunday the
   * designations, the news and now the scoring beside every shared name were
   * whatever they had been at breakfast — while the tiles above them moved.
   *
   * A failed refresh keeps the last good reading rather than blanking the
   * section, which would look like nobody being shared at all.
   */
  useEffect(() => {
    const load = () =>
      fetch('/api/cockpit/exposure').then((r) => r.json()).then(setD).catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  if (!d?.shared?.length) return null
  /*
   * Everyone held in more than one league, whether or not he is starting this
   * week. Riding on a name is about how many of your teams depend on him, and
   * a hamstring costs you in all of them regardless of where he sat on Sunday —
   * so filtering to this week's starters answered a different question than the
   * section asks.
   *
   * The order still leads with the men actually starting, since that is what is
   * at stake right now; the rest follow, marked as bench.
   */
  const shown = d.shared
  if (!shown.length) return null
  return (
    <>
      <div className="cksect">
        Riding on one name
        <span className="cksecthint"> — the same player, more than one league</span>
      </div>
      {/* The ones where a designation costs more than one team, with the
          reason attached — a tag alone cannot tell you whether to worry. */}
      {d.atRisk?.map((e: any) => (
        <div className="ckriding" key={e.playerId}>
          <div className="ckridingh">
            <b>{e.name}</b>
            <InjuryTag status={e.injuryStatus} body={null} practice={e.practice}
                       severity={e.severity} why={e.why} />
            <span className="ckridingn">
              starts in {e.startingIn} · {e.projectedAcross.toFixed(1)} pts at stake
            </span>
          </div>
          {e.practice && (
            <div className="ckridingp">
              Practice: {e.practice}
              {e.severity === 'likely-out' && ' — most of the way to out'}
              {e.severity === 'likely-plays' && ' — a precaution'}
            </div>
          )}
          {e.why?.headline && (e.why.link
            ? <a className="ckridingw" href={e.why.link} target="_blank" rel="noreferrer">
                {e.why.headline} ›
              </a>
            : <span className="ckridingw plain">{e.why.headline}</span>
          )}
        </div>
      ))}
      <div className="ckexp">
        {shown.map((e: any) => (
          <div className="ckexprow" key={e.playerId}>
            <span className="ckexpn">
              {e.name}
              {e.injuryStatus && <InjuryTag status={e.injuryStatus} body={null} why={null} />}
            </span>
            <span className="ckexpl">
              {e.leagues.map((l: any) => (
                <span key={l.leagueId} className={l.starter ? 'on' : ''}
                      style={leagueStyle(l.leagueId)}>{l.label}</span>
              ))}
            </span>
            <span className="ckexpp">
              <ExposureScore e={e} />
            </span>
            {/* Healthy players only: a hurt one already has his headline on the
                card above, and saying it twice is how a list starts being
                skimmed. */}
            {!e.injuryStatus && e.news && (
              e.news.link
                ? <a className="ckexpnews" href={e.news.link} target="_blank" rel="noreferrer">
                    {e.news.headline} ›
                  </a>
                : <span className="ckexpnews">{e.news.headline}</span>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * One league's trade partners.
 *
 * Not four trades — one need, and four managers who could fill it. Written as
 * four rows it repeated itself twice over: the same explanation under every
 * row, and the same two players of mine offered in every one of them, because
 * what I can spare does not change per partner. Said once at the top, the rows
 * carry only what actually differs — who, and what they would send back.
 *
 * The cards are the app's own: same shape as a league tile, same coloured left
 * edge, so the screen belongs to the same program as the one before it.
 */
function TradeLeague({ lg }: { lg: any }) {
  const fits = lg.fits ?? []
  const [open, setOpen] = useState(fits.length > 0)
  const need = fits[0]?.theyCanSpare.pos
  const spare = fits[0]?.youCanSpare

  return (
    <div className="cktl" style={leagueStyle(lg.leagueId)}>
      <button className="cktlh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cknm">{lg.label}</span>
        <span className="ckfmt">
          {lg.blocked ? 'unavailable' : fits.length ? `${fits.length} partners` : 'no fit'}
        </span>
        <span className="cksp" />
        <span className={`ckchev ${open ? 'open' : ''}`} aria-hidden="true">›</span>
      </button>

      {open && (
        <div className="cktlb">
          {lg.blocked && <p className="cktlnote">{lg.blocked}</p>}

          {!lg.blocked && !fits.length && (
            <p className="cktlnote">
              Nobody is deep where you are thin. That is a finding, not a gap — no trade
              here is obviously worth proposing.
            </p>
          )}

          {/* The half that is the same for every partner, said once. */}
          {!!fits.length && (
            <div className="cktlask">
              <span>
                You need a <b>{need}</b>, and can spare a <b>{spare.pos}</b>:
              </span>
              <span className="cktlspare">
                {spare.players.map((p: any) => (
                  <em key={p.name}>{p.name} <i>{p.projected?.toFixed(1) ?? '—'}</i></em>
                ))}
              </span>
            </div>
          )}

          {/* And the half that differs: who, and what comes back. */}
          <div className="ckgrid">
            {fits.map((f: any, i: number) => (
              <div className="ck cktcard" key={f.teamId}>
                <div className="ckhead">
                  <span className="cktseed">{i + 1}</span>
                  <span className="cknm sm">{f.manager}</span>
                  <span className="cksp" />
                  <span className="ckpill quiet">{f.theyCanSpare.pos}</span>
                </div>
                <div className="cktgets">
                  {f.theyCanSpare.players.map((p: any) => (
                    <span key={p.name}>
                      {p.name}<b>{p.projected?.toFixed(1) ?? '—'}</b>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface SweepData {
  week: number
  playingWeek: number
  rows: {
    id: string; name: string; pos: string | null; team: string | null; best: number
    opponent?: string | null; dvpRank?: number | null; dvpOf?: number | null
    outlook?: number | null; byeIn?: number | null
    snapTrend?: number | null; targetTrend?: number | null
    snapShare?: number | null; trendWeeks?: number | null
    chances: {
      leagueId: string; label: string; fills: string
      why: 'hole' | 'cover' | 'upgrade' | 'rising'
      projected: number | null; gain: number; onWaivers: boolean
      drop: { id: string; name: string; pos: string | null; projected: number | null } | null
      budgetLeft: number | null
    }[]
  }[]
  games: { done: number; of: number; next: number | null }
  leagues: { leagueId: string; label: string; holes: number; read: boolean
             free: number; bar: number | null; link: string | null
             freeAsOf: number | null; clearsAt: number | null; budgetLeft: number | null }[]
  skipped: { label: string; why: string }[]
}

/* What each kind of case is, in the words the screen uses for it. */
const WHY: Record<string, { tag: string; says: string }> = {
  hole: { tag: 'fills', says: 'a starting slot with nobody in it' },
  cover: { tag: 'cover', says: 'a starter who may not play, and nobody behind him' },
  upgrade: { tag: 'better', says: 'better than what is starting there' },
  rising: { tag: 'rising', says: 'his role is growing — a bench spot on spec, not a start this week' },
}

/*
 * The Monday sweep: every league's wire under one list.
 *
 * The job is the hour after the week's games — who is needed because somebody
 * got hurt, and who is worth a bench spot on spec — and until this it meant
 * opening six league pages and holding the answer in your head, because the
 * same man is free in three of them and rostered in the others, and is worth a
 * different number in each.
 *
 * Ranked by the best he does anywhere, and it says what the ranking stands on:
 * on the Monday this is for, a game is usually still to be played.
 */
function Sweep() {
  const [d, setD] = useState<SweepData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/cockpit/sweep').then((r) => r.json())
      .then((x) => { if (live) (x?.error ? setErr(String(x.error)) : setD(x)) })
      .catch((e) => { if (live) setErr(String(e)) })
    return () => { live = false }
  }, [])

  if (err) return <p className="cknote dim">The sweep could not be read: {err}</p>
  if (!d) return <p className="cknote dim">Reading every league's wire…</p>

  const left = d.games.of - d.games.done
  /*
   * Where to go and do it. On a phone these open the league's own app, which
   * claims the domain; on a desktop, the site. Either way the claim itself is
   * made there — this screen says who and why, and hands over.
   */
  const linkTo = new Map(d.leagues.map((l) => [l.leagueId, l.link]))
  const League = ({ id, label }: { id: string; label: string }) => {
    const href = linkTo.get(id)
    return href
      ? <a className="ckswl" href={href} target="_blank" rel="noopener noreferrer"
           title={`Open ${label} — the app if you have it, the site if not`}>{label}</a>
      : <span className="ckswl">{label}</span>
  }
  return (
    <>
      <Head
        big={d.rows.length ? `${d.rows.length} worth a claim` : 'Nothing worth a claim'}
        sub={`For week ${d.week} · every league's wire at once`}
      />
      {/*
        * What the ranking is standing on. A projection is a guess about a game
        * that has not been played, and on the Monday this screen is for, one
        * usually has not — said on the face of it rather than left for the
        * reader to remember.
        */}
      <p className="cknote dim">
        {d.week > d.playingWeek
          ? `Week ${d.playingWeek} is done${left > 0 ? ` bar ${left} game${left === 1 ? '' : 's'}` : ''}, so this ranks week ${d.week} — the week a claim made now would first play in, not the one just finished.`
          : `${d.games.done} of ${d.games.of} week ${d.week} games played, so this is ranked on what is still to come.`}
      </p>
      {!!d.skipped.length && (
        <p className="cknote dim">
          Not read: {d.skipped.map((s) => `${s.label} (${s.why})`).join('; ')}
        </p>
      )}
      {!d.rows.length && (
        <p className="cknote">
          Every starting slot is filled and nothing on any wire beats what you
          have.
        </p>
      )}
      <div className="cksweep">
        {d.rows.map((r) => (
          <div className="cksweeprow" key={r.id}>
            <div className="cksweepn">
              <b>{r.name}</b>
              {/*
                * Who he plays, and how that defence ranks against his position.
                * It is what separates two men who project alike — and the
                * optimiser has already used it to order them, so the row owes
                * the reader the reason.
                */}
              <em>
                {r.pos}{r.team ? ` · ${r.team}` : ''}
                {r.opponent ? ` vs ${r.opponent}` : ''}
                <DefenceRank p={r} />
              </em>
              {/*
                * The level behind the week: what he averages over the next
                * three, byes left out, and the bye itself said separately
                * because it is a fact about the calendar rather than the man.
                */}
              <em className="ckswo">
                {r.outlook != null && <>{r.outlook.toFixed(1)} over 3w</>}
                {r.byeIn != null && <span className="bye"> · bye wk {r.byeIn}</span>}
                {/*
                  * The share as well as the move. "+33%" says nothing about
                  * whether he is on the field; "51% of snaps, up 33" says both
                  * — and the number of weeks behind it matters most in
                  * September, when a trend is one week against one other.
                  */}
                {(r.snapTrend ?? 0) > 0 && (
                  <span className="up">
                    {' · '}
                    {r.snapShare != null && `${Math.round(r.snapShare * 100)}% snaps, `}
                    up {Math.round((r.snapTrend ?? 0) * 100)}
                    {r.trendWeeks != null && r.trendWeeks < 4 && (
                      <span className="thin" title="A trend this early is one week against the weeks before it">
                        {' '}({r.trendWeeks}w)
                      </span>
                    )}
                  </span>
                )}
              </em>
            </div>
            <div className="cksweepc">
              {r.chances.map((c) => (
                <div className="cksweepch" key={c.leagueId}>
                  <League id={c.leagueId} label={c.label} />
                  <span className={`ckswhy ${c.why}`} title={WHY[c.why].says}>
                    {WHY[c.why].tag} {c.fills}
                  </span>
                  {c.why === 'rising'
                    ? <span className="ckswg spec">on spec</span>
                    : <span className="ckswg">+{c.gain.toFixed(1)}</span>}
                  {/* What it costs, which is the half of a claim nobody shows. */}
                  <span className="ckswd">
                    {c.drop ? <>drop <b>{c.drop.name}</b></> : 'nobody spare to drop'}
                  </span>
                  <span className="ckswm">
                    {c.onWaivers ? 'on waivers' : 'free now'}
                    {c.budgetLeft != null && ` · $${c.budgetLeft} left`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/*
        * No suggested bid. There is a budget here and rivals have budgets too,
        * and nothing in the app turns those into a number — one invented here
        * would be the most confident wrong figure on the screen.
        */}
      <div className="cksect">
        Where each league stands
        <span className="cksecthint"> — holes, when waivers clear, and what is left to bid</span>
      </div>
      <div className="ckexp">
        {d.leagues.map((l) => (
          <div className="ckexprow" key={l.leagueId}>
            <span className="ckexpn"><League id={l.leagueId} label={l.label} /></span>
            <span className="ckexpl">
              {!l.read && <span>wire not read</span>}
              {l.holes > 0 && <span className="on">{l.holes} {l.holes === 1 ? 'hole' : 'holes'}</span>}
              {/*
                * Why a league said nothing. "Nothing here" and "nothing here
                * that beats 12.4 off a wire of 400" are different answers, and
                * only the second one tells you whether to go and look yourself.
                */}
              {l.read && l.bar != null && (
                <span title={`${l.free} projected free agents were considered`}>
                  {l.free} free · {l.bar > 0 ? `beat ${l.bar.toFixed(1)}` : 'any body helps'}
                </span>
              )}
              {l.clearsAt != null && (
                <span>clears {new Date(l.clearsAt).toLocaleDateString(undefined, { weekday: 'short' })}</span>
              )}
            </span>
            <span className="ckexpp">{l.budgetLeft != null ? `$${l.budgetLeft}` : '—'}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/* The two cross-league tools, which are the only two that earned the tab. */
function MovesTab({ tiles }: { tiles: Tile[] }) {
  const [seg, setSeg] = useState<'Wire' | 'Trades'>('Wire')
  return (
    <>
      <Seg opts={['Wire', 'Trades']} on={seg} set={setSeg} />
      {seg === 'Wire' ? <Sweep /> : <Plan tiles={tiles} />}
    </>
  )
}

/**
 * Trades: the one question that needs every manager's roster rather than only
 * yours. Valuing an offer is solved everywhere; finding one is not, so this
 * finds and stops — it proposes a conversation, never a price.
 */
function Plan({ tiles }: { tiles: Tile[] }) {
  const [data, setData] = useState<any[] | null>(null)
  useEffect(() => {
    fetch('/api/cockpit/trades').then((r) => r.json()).then(setData).catch(() => setData([]))
  }, [])

  return (
    <>
      {/* Counted, not written in: there were four leagues when this was, and there are more now. */}
      <Head big="Trades" sub={`Every manager's roster, in ${data?.length ?? tiles.length} leagues at once`} />
      {data === null && <div className="ckempty">Reading every roster…</div>}
      {data?.map((lg) => <TradeLeague key={lg.leagueId} lg={lg} />)}
      <p className="cknote dim">
        Bye weeks and FAAB moved to each league's own screen, where they belong — both are
        facts about one league, and only trades need every roster at once.
      </p>
    </>
  )
}

/**
 * The one thing a lineup screen owes you: whether to change anything. Silence
 * here has to mean "your lineup is right", so the settled case is stated
 * outright rather than left as an empty space you cannot tell from a bug.
 */
type Side = {
  /** 'Yahoo' or 'Sleeper': whose projection this row shows. */
  projectedFrom?: string | null
  injuryBody?: string | null
  practice?: string | null
  severity?: string | null
  playRate?: PlayRate | null
  reportPending?: boolean | null
  /** Sleeper's note or a headline that explains the designation. */
  why?: Why | null
  id: string; name: string; pos: string | null; projected: number | null; starter?: boolean
  injuryStatus?: string | null
  weekRank?: number | null; weekSpread?: number | null
  dvpRank?: number | null; dvpOf?: number | null
  opponent?: string | null
  /** Share of his own team's targets and carries, and over how many weeks. */
  role?: number | null; roleWeeks?: number | null
  weather?: { roof: string; tempF: number | null; windMph: number | null; summary: string | null } | null
  coverage?: Cover | null
}

/** One player's row inside a close call: the things that break the tie. */
function Evidence(
  { p, starting, preferred }: { p: Side; starting?: boolean; preferred?: boolean },
) {
  const wx = p.weather
  return (
    <div className={`ckcc-row ${preferred ? 'in' : ''}`}>
      <span className="ckcc-nm">
        {p.name}
        {/*
          * His designation, on the row where the decision is made. The card
          * had every other signal — rank, role, defence, weather — and not the
          * one that says whether he will be on the field: a questionable man
          * preferred by four tenths over a healthy one is not the same call.
          */}
        {p.injuryStatus && (
          <InjuryTag status={p.injuryStatus} body={p.injuryBody} practice={p.practice}
                     severity={p.severity} why={p.why} rate={p.playRate} pending={p.reportPending} />
        )}
        {starting && <span className="ckcc-tag">in lineup</span>}
        {preferred && !starting && <span className="ckcc-tag pref">preferred</span>}
      </span>
      <span className="ckcc-pr">
        {p.projected != null ? p.projected.toFixed(1) : '—'}
        {/* A number from the other model, where Yahoo printed none for him:
            the two sides of this row are then not quite like for like. */}
        {p.projectedFrom === 'Sleeper' && (
          <i className="ckprojs" title="Yahoo printed no projection for him — this is Sleeper's, scored your league's way">s</i>
        )}
      </span>
      <span className="ckcc-rk">
        {p.weekRank != null
          ? <>{p.pos}{p.weekRank}{p.weekSpread ? <em> ±{p.weekSpread.toFixed(1)}</em> : null}</>
          : <span className="ckcc-none">no rank</span>}
      </span>
      {/* How much of his own offence he has been. One week is a game script,
          so the count of weeks is shown beside it rather than left implied. */}
      <span className="ckcc-ro">
        {p.role != null
          ? <>{(p.role * 100).toFixed(0)}%{p.roleWeeks ? <em> /{p.roleWeeks}w</em> : null}</>
          : <span className="ckcc-none">—</span>}
      </span>
      <span className="ckcc-mu">
        <span className="ckcc-mut">
          {p.dvpRank != null && p.dvpOf
            ? <>{p.opponent} {ordinal(p.dvpRank)}/{p.dvpOf}</>
            : <span className="ckcc-none">{p.opponent ?? '—'}</span>}
        </span>
        {/* The defence as a whole, then the one man in it he will see most of. */}
        <CoverageTag c={p.coverage} />
      </span>
      <span className="ckcc-wx">
        {wx ? (wx.summary ?? (wx.tempF != null ? `${Math.round(wx.tempF)}°` : '—')) : '—'}
      </span>
    </div>
  )
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

/**
 * Advice, and where there is none, the reason.
 *
 * A swap the projections cannot actually see is not a swap. It used to be
 * printed as "+0.6 on the table" in the same voice as "+6.0", which invites a
 * lineup change on a difference the model cannot resolve — so a close call now
 * shows what took the projection's place instead of a smaller number.
 */
function Advice({ advice }: { advice: NonNullable<Detail['roster']>['advice'] }) {
  if (!advice) return null
  const real = advice.swaps.filter((s) => !s.close)
  // A swap against an unread projection is a thing to check, not points won.
  const measured = real.filter((s) => !s.unknownOut)
  const toCheck = real.filter((s) => s.unknownOut)
  const close = advice.closeCalls ?? []
  // Only a call you could act on earns the room. One resolved in favour of the
  // man already starting is worth a line, not a table.
  /*
   * A split call earns the full card even when nothing needs moving.
   *
   * These were shown only when acting meant a substitution, which hid the one
   * kind worth reading: the optimiser keeping the man already in the lineup
   * because the consensus said so, while the usage pointed the other way. There
   * is nothing to do about it and that is not the same as nothing to know.
   */
  // A better free agent makes a call worth reading even when my two agree.
  const actionable = close.filter((c) => c.change || c.split || c.wire)
  const settled = close.filter((c) => !c.change && !c.split && !c.wire)

  const verdict = (c: NonNullable<typeof advice.closeCalls>[number]) => {
    const dissent = (c.split?.votes ?? []).filter((v) => v.prefers === c.alternative.name)
    const why =
      /*
       * Outside the coin flip the projection has an opinion, so the sentence
       * cannot say it did not decide. It did; two other signals disagree.
       */
      c.tight === false
        ? <>the projection prefers <b>{c.keep.name}</b> by {c.gap.toFixed(1)}, and {
            dissent.length === 2 ? 'two other signals' : `${dissent.length} other signals`
          } read it the other way</>
      : c.by === 'consensus' ? <>the consensus prefers <b>{c.keep.name}</b>, and the projection does not decide it</>
      : c.by === 'role' ? <><b>{c.keep.name}</b> has the bigger share of his own offence, and nothing else separates them</>
      : c.by === 'matchup' ? <><b>{c.keep.name}</b> draws the softer defence, and nothing else separates them</>
      : c.by === 'projection' ? <>only {c.gap.toFixed(1)} between them, and nothing else to go on</>
      : <>nothing separates them</>
    /*
     * Only where acting means moving somebody. This was appended to every card
     * because every card shown was one where the preferred man sat on the
     * bench — and the moment split calls joined them it was telling you that a
     * receiver tagged "in lineup" two lines below was on your bench.
     */
    return c.change
      ? <>{why} — <b className="ckcc-act">he is on your bench</b></>
      : <>{why} — <b className="ckcc-keep">he is the one you are starting</b></>
  }

  if (!real.length && !close.length) {
    return (
      <div className="ckadv set">
        <span className="ckadvi">✓</span>
        <span>
          <b>Your lineup is the best you can field.</b>
          <em>Every bench player projects below the starter he would replace.</em>
        </span>
      </div>
    )
  }
  return (
    <>
      {real.length > 0 && (
        <div className="ckadv">
          <div className="ckadvh">
            {measured.length > 0 ? (
              <>Start/sit · <b>+{(advice.decisive ?? advice.gain).toFixed(1)}</b> on the table</>
            ) : (
              /* Nothing measurable: saying "+0.0 on the table" over a swap
                 worth checking reads as advice to do nothing. */
              <>Start/sit · <b>{toCheck.length === 1 ? 'one to check' : `${toCheck.length} to check`}</b></>
            )}
          </div>
          {real.map((s) => (
            <div className="ckadvr" key={s.in.id}>
              <span className="ckadvin">
                {/* His own projection where there is nothing to subtract it from. */}
                <em className={s.unknownOut ? 'ckadvq' : ''}>
                  {s.unknownOut
                    ? (s.in.projected != null ? `${s.in.projected.toFixed(1)} in` : 'check')
                    : `+${s.gain.toFixed(1)}`}
                </em>
                <b>{s.in.name}</b>
                <span className="ckadvs">into {s.slot}</span>
              </span>
              {s.out && (
                <span className="ckadvout">
                  for <b>{s.out.name}</b>
                  {s.reason === 'out'
                    ? <span className="ckadvwhy out">ruled {(s.out.injuryStatus ?? 'out').toLowerCase()}</span>
                    : s.out.projected == null
                      /* Not nought: nobody read it. Printing 0.0 made a gap look
                         like a player projected to score nothing. */
                      ? <span className="ckadvwhy none">no projection read</span>
                      : <span className="ckadvwhy">{s.out.projected.toFixed(1)}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/*
        * One statement, not two. A green tick reading "the best you can field"
        * sat directly above an amber panel reading "too close to call", and
        * together they looked like an argument. They are not: the tick is true
        * on points, and the panel is about a gap the points cannot resolve. So
        * where there is a call to make, the tick becomes that card's opening
        * line and says which of the two it means.
        */}
      {!real.length && !actionable.length && (
        <div className="ckadv set">
          <span className="ckadvi">✓</span>
          <span>
            <b>Your lineup is the best you can field.</b>
            <em>
              {settled.length > 0
                ? `${settled.map((c) => `${c.keep.name} over ${c.alternative.name}`).join(', ')} was close, and went the way you have it.`
                : 'Every bench player projects below the starter he would replace.'}
            </em>
          </span>
        </div>
      )}

      {actionable.map((c) => (
        <div className="ckadv close" key={`c-${c.slot}-${c.keep.id}`}>
          {!real.length && (
            <div className="ckcc-lede">
              <span className="ckadvi">✓</span>
              <span>
                <b>Your lineup is the best you can field on points.</b>
                <em>One slot is closer than the projection can see.</em>
              </span>
            </div>
          )}
          <div className="ckadvh close">
            {c.tight === false ? 'Worth a second look' : 'Too close to call'} · <b>{c.slot}</b>
            {c.split && <span className="ckcc-split">signals disagree</span>}
            <span className="ckcc-hint">
              {c.gap.toFixed(1)} apart — {c.tight === false
                ? 'inside three points, where the projection is right about three times in five'
                : 'inside what a weekly projection can see'}
            </span>
          </div>
          {/*
            * What each signal says, where they say different things. The
            * optimiser has to pick one and takes the first opinion it gets;
            * this hands the call back with its reasoning instead of settling it
            * quietly, which is the only honest thing to do when the evidence
            * is genuinely split.
            */}
          {c.split && (
            <div className="ckcc-why">
              {c.split.votes.map((v) => (
                <div className="ckcc-vote" key={v.signal}>
                  <span className="ckcc-sig">{v.signal}</span>
                  <span><b>{v.prefers}</b> — {v.why}</span>
                </div>
              ))}
              {c.split.caveat && <p className="ckcc-caveat">{c.split.caveat}</p>}
            </div>
          )}
          <div className="ckcc-head">
            <span className="ckcc-nm">player</span>
            <span className="ckcc-pr">proj</span>
            <span className="ckcc-rk">consensus</span>
            <span className="ckcc-ro">role</span>
            <span className="ckcc-mu">defence faced</span>
            <span className="ckcc-wx">conditions</span>
          </div>
          <Evidence p={c.keep as Side} starting={!!c.keep.starter} preferred />
          <Evidence p={c.alternative as Side} starting={!!c.alternative.starter} />
          <div className="ckcc-verdict">{verdict(c)}</div>
          {c.wire && (
            <div className="ckcc-wire">
              Or neither: <b>{c.wire.name}</b>{c.wire.pos ? ` (${c.wire.pos})` : ''} is{' '}
              {c.wire.onWaivers ? 'on waivers, claimable overnight,' : 'a free agent'} and projects{' '}
              {c.wire.projected?.toFixed(1) ?? '—'} to the better of these two's {c.wire.over.toFixed(1)}
              <span className="ckcc-hint"> — all three on Sleeper's numbers, scored your league's way</span>
            </div>
          )}
        </div>
      ))}
    </>
  )
}

/* ----------------------------------------------------------------- review */

function Review() {
  const [on, setOn] = useState<'Season' | 'Drafts'>('Drafts')
  const [drafts, setDrafts] = useState<any[] | null>(null)
  useEffect(() => { fetch('/api/drafts').then((r) => r.json()).then(setDrafts).catch(() => setDrafts([])) }, [])
  return (
    <>
      <Seg opts={['Season', 'Drafts']} on={on} set={setOn} />
      {on === 'Season' && (
        <Placeholder title="Did my start/sit calls beat the bench?" needs="week one — there is nothing to review until games are played"
          why="The same idea as draft Tendencies, one phase later: the gap between what you did and what was available, with the sample size stated honestly." />
      )}
      {on === 'Drafts' && (
        <div className="ckgrid">
          {(drafts ?? []).map((d) => (
            <a className={`ck ${d.excluded ? 'blocked' : 'quiet'}`} key={d.key} href={`/draft?review=${d.key}`}>
              <div className="ckhead">
                <span className="cknm sm">{d.leagueLabel}</span>
                <span className="ckfmt">{d.teams}tm · {d.rounds}rd</span>
              </div>
              <div className="ckwhy">
                {d.picks} picks · slot {d.mySlot ?? '—'} · {new Date(d.startedAt).toLocaleDateString()}
              </div>
              <div className="ckfoot">
                <span className={`ckpill ${d.excluded ? 'blocked' : 'quiet'}`}>{d.excluded ? 'Excluded' : 'Reviewable'}</span>
                <span className="cksp" />
                <span className="ckfresh">{d.platform}</span>
              </div>
            </a>
          ))}
          {drafts && !drafts.length && <div className="ckempty">No drafts recorded yet.</div>}
        </div>
      )}
    </>
  )
}

/*
 * Text size and theme, shared with the draft companion through the same
 * localStorage keys — one setting for one person, not two apps disagreeing
 * about how large the type should be.
 */
const SCALES = [0.9, 1, 1.1, 1.25, 1.4]

function useDisplay() {
  const [scale, setScale] = useState(() => Number(localStorage.getItem('ui-scale')) || 1)
  const [theme, setTheme] = useState(() => localStorage.getItem('ui-theme') || 'dark')
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(scale))
    localStorage.setItem('ui-scale', String(scale))
  }, [scale])
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('ui-theme', theme)
  }, [theme])
  return { scale, setScale, theme, setTheme }
}

function Display() {
  const { scale, setScale, theme, setTheme } = useDisplay()
  return (
    <div className="ckdisp">
      <div className="ckdrow">
        <span>
          <span className="ckrn">Text size</span>
          <span className="ckrd">Applies to the draft companion too</span>
        </span>
        <span className="cksizes">
          {SCALES.map((v) => (
            <button key={v} className={v === scale ? 'on' : ''} onClick={() => setScale(v)}>
              {Math.round(v * 100)}%
            </button>
          ))}
        </span>
      </div>
      <div className="ckdrow">
        <span>
          <span className="ckrn">Theme</span>
          <span className="ckrd">Dark is built for a draft room at 10pm</span>
        </span>
        <span className="cksizes">
          {['dark', 'light'].map((t) => (
            <button key={t} className={t === theme ? 'on' : ''} onClick={() => setTheme(t)}>{t}</button>
          ))}
        </span>
      </div>
    </div>
  )
}


/**
 * The way in.
 *
 * A passkey is bound to this origin and to the phone holding it, so Face ID
 * replaces a token sitting in a bookmarked URL — which was the weakest part of
 * guarding this at all. The token survives for two jobs it is actually good at:
 * enrolling a new device, and getting the browser extension through, since an
 * extension cannot perform WebAuthn.
 *
 * There is no username and no password. One user means a username identifies
 * nobody, and a password is a memorised secret that can be weak, reused or
 * phished — every failure a passkey exists to remove.
 */
function Lock({ onIn }: { onIn: () => void }) {
  const [state, setState] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [token, setToken] = useState('')

  /*
   * The token has to be usable from here.
   *
   * A passkey enrolled on another device is not a way into this one: iOS sees
   * no local credential and offers to scan a QR code from the machine that has
   * one, which is no help when that machine is somewhere else. The button said
   * "Unlock with Face ID" and there was no other way in — on the device that
   * had never been enrolled, which is the only device that needs one.
   */
  async function useToken() {
    setBusy(true); setErr('')
    const t = token.trim()
    try {
      // Check it before navigating, so a wrong token says so here rather than
      // bouncing back to this screen with nothing to explain why.
      const r = await fetch(`/api/auth/passkey/state?token=${encodeURIComponent(t)}`)
      if ((await r.json()).needsToken) { setErr('That token was not accepted.'); return }
      /*
       * Then go in through the address, which is the path that sets the
       * cookie. Asking the passkey route to do it does not work: those
       * handlers answer before the cookie is written, so the token opened that
       * one request and nothing after it.
       */
      window.location.href = `/home?token=${encodeURIComponent(t)}`
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally { setBusy(false) }
  }

  useEffect(() => {
    fetch('/api/auth/passkey/state').then((r) => r.json()).then(setState).catch(() => {})
  }, [])

  async function unlock() {
    setBusy(true); setErr('')
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser')
      const opts = await fetch('/api/auth/passkey/login-options').then((r) => r.json())
      const cred = await startAuthentication({ optionsJSON: opts })
      const out = await fetch('/api/auth/passkey/login-verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cred),
      }).then((r) => r.json())
      if (out.ok) onIn(); else setErr(out.error ?? 'that did not verify')
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally { setBusy(false) }
  }

  if (!state) return <div className="ckempty">…</div>

  const enrolled = state.count ?? state.enrolled.length
  return (
    <div className="cklock">
      <div className="cklockbox">
        <img className="cklockicon" src="/icon.svg" alt="" width="56" height="56" />
        <h1>Fantasy Companion</h1>
        <div className="cklocksub">Four leagues · one screen</div>

        {enrolled ? (
          <>
            <button className="cklockbtn" disabled={busy} onClick={unlock}>
              {busy ? 'Waiting for you…' : 'Unlock with Face ID'}
            </button>
            <div className="cklockfoot">
              {enrolled} device{enrolled === 1 ? '' : 's'} enrolled — this one may not be
            </div>
          </>
        ) : (
          /* The first visit on a new device. It is not an error, so it does not
             look like one — it is the one instruction that gets you in. */
          <div className="cklockcard">
            <div className="cklockcardh">First time on this device</div>
            <p>
              Open this address once with <code>?token=</code> and your token on the
              end, then add this device under <b>Set → Getting in</b>.
            </p>
            <p className="dim">The token is in your password manager.</p>
          </div>
        )}

        {/* Always available, because a passkey on another device cannot open
            this one, and this is how a new device gets enrolled at all. */}
        {!showToken ? (
          <button className="cklocklink" onClick={() => setShowToken(true)}>
            Use my token instead
          </button>
        ) : (
          <div className="cklocktoken">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste your token"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') useToken() }}
            />
            <button className="cklockbtn tight" disabled={busy || !token.trim()} onClick={useToken}>
              {busy ? 'Checking…' : 'Unlock'}
            </button>
            <p className="cklockp">
              Then add Face ID for this device under <b>Set → Getting in</b>.
            </p>
          </div>
        )}

        {err && (
          <div className="cklockcard err">
            <div className="cklockcardh">That did not work</div>
            <p>{err}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Adds this device, once you are already in. */
function AddPasskey() {
  const [state, setState] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  const refresh = () =>
    fetch('/api/auth/passkey/state').then((r) => r.json()).then(setState).catch(() => {})
  useEffect(() => { refresh() }, [])

  async function add() {
    setBusy(true); setSaid('')
    try {
      const { startRegistration } = await import('@simplewebauthn/browser')
      const opts = await fetch('/api/auth/passkey/register-options').then((r) => r.json())
      if (opts.error) { setSaid(opts.error); return }
      const credential = await startRegistration({ optionsJSON: opts })
      const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone'
        : /Mac/.test(navigator.userAgent) ? 'Mac' : 'this device'
      const out = await fetch('/api/auth/passkey/register-verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential, label }),
      }).then((r) => r.json())
      setSaid(out.ok ? 'This device can now unlock with Face ID.' : (out.error ?? 'failed'))
      refresh()
    } catch (e: any) { setSaid(e?.message ?? String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="ckpush">
      <div className="ckpushh">Getting in</div>
      <div className="ckpushrow">
        <span>
          <span className="ckrn">Passkeys</span>
          <span className="ckrd">
            {state?.enrolled?.length
              ? state.enrolled.map((e: any) => e.label).join(', ')
              : 'none yet — the token is the only way in'}
          </span>
        </span>
        <button className="ckbtn" disabled={busy} onClick={add}>
          {busy ? 'Waiting…' : 'Add this device'}
        </button>
      </div>
      {said && <p className="cknote">{said}</p>}
      <p className="cknote dim">
        Keep the token in your password manager. It enrols a new device if you lose this
        one, and it is the only thing the browser extension can present — extensions
        cannot use Face ID.
      </p>
    </div>
  )
}

/**
 * Turning notifications on, and proving they arrive.
 *
 * The chain has four links — a service worker, a permission grant, a
 * subscription the server keeps, and a push service that will drop it without
 * telling anyone — so each one reports its own state rather than being inferred
 * from the last. A test send is the only way to know the whole thing works
 * before it matters on a Sunday.
 */
function PushSetup() {
  const [state, setState] = useState<any>(null)
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default')
  const [busy, setBusy] = useState('')
  const [said, setSaid] = useState('')

  const refresh = () => fetch('/api/push/key').then((r) => r.json()).then(setState).catch(() => {})
  useEffect(() => { refresh() }, [])

  const standalone = typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
     (window.navigator as any).standalone === true)
  const iOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)

  async function enable() {
    setBusy('enable'); setSaid('')
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const p = await Notification.requestPermission()
      setPerm(p)
      if (p !== 'granted') { setSaid('Permission refused — nothing can be delivered.'); return }
      const { key } = await fetch('/api/push/key').then((r) => r.json())
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'))
      const bytes = new Uint8Array([...raw].map((c) => c.charCodeAt(0)))
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: bytes,
      })
      await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
      })
      setSaid('This device is subscribed.')
      refresh()
    } catch (e: any) {
      setSaid(`Could not subscribe: ${e?.message ?? e}`)
    } finally { setBusy('') }
  }

  async function test() {
    setBusy('test'); setSaid('')
    const r = await fetch('/api/push/test', { method: 'POST' }).then((x) => x.json())
    setSaid(r.web > 0
      ? `Sent to ${r.web} device${r.web === 1 ? '' : 's'}. If nothing arrived, the subscription is stale.`
      : 'Nothing to send to — no device is subscribed yet.')
    setBusy(''); refresh()
  }

  return (
    <div className="ckpush">
      <div className="ckpushh">Delivery</div>
      {iOS && !standalone && (
        <p className="cknote warn">
          <b>Add this to your Home Screen first.</b> iOS delivers web push only to an
          installed app — Share, then Add to Home Screen, then open it from there and
          turn notifications on. In Safari alone the button below cannot work.
        </p>
      )}
      <div className="ckpushrow">
        <span>
          <span className="ckrn">This device</span>
          <span className="ckrd">
            {perm === 'granted' ? 'permission granted' : perm === 'denied'
              ? 'permission refused — reset it in site settings' : 'not yet asked'}
            {state ? ` · ${state.subscribers} subscribed` : ''}
          </span>
        </span>
        <button className="ckbtn" disabled={busy === 'enable'} onClick={enable}>
          {busy === 'enable' ? 'Working…' : 'Turn on'}
        </button>
      </div>
      <div className="ckpushrow">
        <span>
          <span className="ckrn">Alert budget</span>
          <span className="ckrd">
            {state ? `${state.spentThisWeek} sent in the last seven days of ${state.budget}` : '—'}
            {' · a ruled-out starter is never rationed'}
          </span>
        </span>
        <button className="ckbtn" disabled={busy === 'test'} onClick={test}>
          {busy === 'test' ? 'Sending…' : 'Send a test'}
        </button>
      </div>
      {said && <p className="cknote">{said}</p>}
    </div>
  )
}

/* --------------------------------------------------------------- settings */

const RULES = [
  { on: true, n: 'A starter is ruled out', d: 'Status becomes Out, Doubtful or IR — fires immediately' },
  { on: true, n: 'A starter turns questionable', d: 'Only inside three hours of lock, otherwise a note' },
  { on: true, n: 'Waivers close with money unspent', d: 'Six hours before, and only if a target fits a hole' },
  { on: true, n: 'Guillotine survival risk', d: 'Projected bottom three, Sunday morning only' },
  { on: false, n: 'A trade opportunity appears', d: 'No deadline attached, so it cannot notify by our own rule' },
  { on: false, n: 'A trending player you do not own', d: 'Popularity is not a fact about your team' },
]

function Settings({ sources }: { sources: Source[] }) {
  const [on, setOn] = useState<'Rules' | 'Display' | 'Sources' | 'Review'>('Rules')
  const [rules, setRules] = useState(RULES)
  return (
    <>
      <Head big="Settings" sub="Every rule needs a fact, a deadline and a consequence" />
      <Seg opts={['Rules', 'Display', 'Sources', 'Review']} on={on} set={setOn} />
      {on === 'Rules' && (
        <>
          <div className="ckrules">
            {rules.map((r, i) => (
              <button className="ckrule" key={r.n} onClick={() =>
                setRules((rs) => rs.map((x, j) => (i === j ? { ...x, on: !x.on } : x)))}>
                <span>
                  <span className="ckrn">{r.n}</span>
                  <span className="ckrd">{r.d}</span>
                </span>
                <span className={`cktog ${r.on ? 'on' : ''}`} aria-pressed={r.on} />
              </button>
            ))}
          </div>
          <p className="cknote">
            <b>Freshness rule.</b> A source that cannot prove it is current never fires — it degrades
            to a note you find later. That one is not a toggle; it is the guarantee the others rest on.
          </p>
          <AddPasskey />
          <PushSetup />
        </>
      )}
      {on === 'Display' && <Display />}
      {on === 'Review' && <Review />}
      {on === 'Sources' && (
        <div className="ckgrid">
          <div className="ck quiet">
            <div className="ckhead"><span className="cknm sm">Injury practice report</span>
              <span className="ckfmt">nflverse</span></div>
            <div className="ckwhy">
              Whether a player practised, which is what separates a precaution from a problem —
              questionable after a full week means something very different to questionable
              having not practised at all.
            </div>
            <div className="ckfoot">
              <span className="ckpill blocked">Not published yet</span>
              <span className="cksp" />
              <span className="ckfresh">the {new Date().getFullYear()} report starts in week one</span>
            </div>
          </div>
          {sources.map((s) => (
            <div className={`ck ${s.connected ? 'quiet' : 'blocked'}`} key={s.id}>
              <div className="ckhead">
                <span className="cknm sm">{s.label}</span>
                <span className="ckfmt">{s.platform} · {s.feed}</span>
              </div>
              <div className="ckwhy">{s.note}</div>
              <div className="ckfoot">
                <span className={`ckpill ${s.connected ? 'quiet' : 'blocked'}`}>
                  {s.connected ? 'Connected' : 'Pending'}
                </span>
                <span className="cksp" />
                <span className="ckfresh">board {agoWords(s.boardAt)} · slot {s.mySlot ?? '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* -------------------------------------------------------------------- app */

function Cockpit() {
  // Read once at mount so the whole app is sized correctly from the first
  // paint, rather than only after Settings has been opened.
  useEffect(() => {
    const sc = Number(localStorage.getItem('ui-scale')) || 1
    document.documentElement.style.setProperty('--ui-scale', String(sc))
    document.documentElement.setAttribute('data-theme', localStorage.getItem('ui-theme') || 'dark')
  }, [])
  const [tab, setTab] = useState<Tab>('now')
  const [openLeague, setOpenLeague] = useState<string | null>(null)
  const [tiles, setTiles] = useState<Tile[] | null>(null)
  const [nba, setNba] = useState<SeasonTile[]>([])
  const [nbaAll, setNbaAll] = useState<{ views: SeasonView[]; drafts: { id: string; label: string; leagueId: string; mock: boolean }[] }>({ views: [], drafts: [] })
  /*
   * A basketball league's page has an address of its own, /nba/league/<id>, so
   * a notification or a draft room can link straight to it and the phone's back
   * gesture leaves it. Football's leagues open in place, as they always have.
   */
  const nbaFromPath = () => location.pathname.match(/^\/nba\/league\/([\w-]+)/)?.[1] ?? null
  const [nbaOpen, setNbaOpenState] = useState<string | null>(nbaFromPath)
  const openNba = (id: string | null) => {
    setNbaOpenState(id)
    setOpenLeague(null)
    if (id) { setTab('now'); history.pushState(null, '', `/nba/league/${id}`) }
    else if (location.pathname !== '/home') history.pushState(null, '', '/home')
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const pop = () => setNbaOpenState(nbaFromPath())
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  /* One sport setting for Now, News and Moves, remembered on this device. */
  const [sport, setSportState] = useState<SportFilter>(() => {
    try { return (localStorage.getItem(SPORT_KEY) as SportFilter) || 'All' } catch { return 'All' }
  })
  const setSport = (v: SportFilter) => { setSportState(v); try { localStorage.setItem(SPORT_KEY, v) } catch { /* private window */ } }
  const [marks, setMarks] = useState<Record<string, any>>({})
  const [closeCalls, setCloseCalls] = useState<Record<string, number>>({})
  /** Why Yahoo has gone quiet, when it has. Null the rest of the time. */
  const [yahooOff, setYahooOff] = useState<{ why: string; since: number | null; until: number | null } | null>(null)
  const [news, setNews] = useState<{ items: Item[]; scanned: number; baseline: number | null } | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [alerts, setAlerts] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [, tick] = useState(0)

  /*
   * Notice when the page you are running is older than the one on disk. Nothing
   * reloads by itself — doing that mid-draft would be worse than being stale —
   * but a banner beats hunting a bug that is really a cached tab.
   */
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const mine = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
      .map((el) => el.src)
      .find((v) => /assets\/cockpit-/.test(v))
    if (!mine) return
    /*
     * Reload rather than ask. The banner was the polite version and it failed
     * twice for the same reason — a tab opened before the banner existed has no
     * banner, so the one case that needed telling was the one case that could
     * not be told. The cockpit is read-only, so losing the page costs nothing;
     * a live draft is the exception and is left alone, because a page that
     * refreshes itself on the clock is worse than one that is out of date.
     */
    const check = () =>
      fetch('/api/build')
        .then((r) => r.json())
        .then((d) => {
          if (!d.entry || mine.endsWith(d.entry)) return
          const drafting = document.querySelector('.ckdraftbar') != null
          if (drafting) { setStale(true); return }
          location.reload()
        })
        .catch(() => {})
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = () => {
      fetch('/api/cockpit').then((r) => r.json())
        .then((d) => {
          setTiles(d.tiles); setMarks(d.marks ?? {}); setNba(d.nba ?? [])
          setCloseCalls(d.closeCalls ?? {}); setYahooOff(d.yahoo ?? null); setErr(null)
        })
        .catch(() => setErr('The companion is not answering on :4600'))
      fetch('/api/cockpit/news').then((r) => r.json()).then(setNews).catch(() => {})
      fetch('/api/nba/season/all').then((r) => r.json()).then((d) => { if (d?.views) setNbaAll(d) }).catch(() => {})
      fetch('/api/cockpit/sources').then((r) => r.json()).then((d) => setSources(d.sources)).catch(() => {})
      fetch('/api/cockpit/notifications').then((r) => r.json()).then(setAlerts).catch(() => {})
    }
    load()
    const a = setInterval(load, 30000)
    const b = setInterval(() => tick((n) => n + 1), 1000)
    return () => { clearInterval(a); clearInterval(b) }
  }, [])

  const markRead = () =>
    fetch('/api/cockpit/notifications', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readAll: true }),
    }).then(() => fetch('/api/cockpit/notifications')).then((r) => r.json()).then(setAlerts)

  const unread = alerts?.unread ?? 0
  const both = !!tiles?.length && nba.length > 0
  const shown: SportFilter = both ? sport : nba.length && !tiles?.length ? 'Basketball' : 'All'
  const needBy = {
    nfl: (tiles ?? []).filter((t) => marks?.[t.id] || closeCalls?.[t.id] || t.urgency === 'act' || t.urgency === 'soon').length,
    nba: nba.filter((t) => t.urgency === 'act' || t.urgency === 'soon').length,
  }
  const fb = shown !== 'Basketball', bb = shown !== 'Football'
  /* The server says whether a draft is running. Asking instead whether the
     draft time had passed and the tile was urgent also described a league that
     drafted yesterday and has not been captured since — which is how an
     eighteen-hour-old draft came to offer a Resume button. */
  const live = tiles?.find((t) => t.phase === 'drafting')

  /*
   * Whether this screen is showing anything Yahoo supplied.
   *
   * The attribution went on every screen at first, on the theory that crediting
   * Yahoo too often costs a line of grey text. It costs more than that: on a
   * Sleeper league's page there is no Yahoo data at all, so "Fantasy data
   * provided by Yahoo Fantasy" was not caution but a false statement — Sleeper's
   * numbers credited to Yahoo, under Yahoo's name. The terms ask for it wherever
   * Yahoo's information is displayed, which is a condition, not a blanket.
   *
   * One league open: that league's platform decides. Anywhere spanning all of
   * them — the home list, news, trades, settings — Yahoo's leagues are on the
   * page if any exist.
   */
  const yahooShown = !!tiles && (
    tab === 'now' && openLeague
      ? tiles.find((t) => t.id === openLeague)?.platform === 'yahoo'
      : tiles.some((t) => t.platform === 'yahoo')
  )

  return (
    <div className="ckapp">
      <nav className="cknav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''}
            /* Tapping a tab returns to its root, including the one you are
               already on — which is what every tab bar on the platform does,
               and the only way back from a league without hunting for the
               crumb at the top of a long page. */
            onClick={() => { setTab(t.id); setOpenLeague(null); if (nbaOpen) openNba(null) }}
            aria-current={tab === t.id ? 'page' : undefined}>
            {t.label}
            {t.id === 'news' && unread > 0 && <span className="ckbadge">{unread}</span>}
          </button>
        ))}
      </nav>
      {stale && (
        <button className="ckstale" onClick={() => location.reload()}>
          A newer build is on disk — this tab is running an older one. Reload
        </button>
      )}
      <main className="ckmain">
        {err && <div className="ckempty">{err}</div>}
        {!err && !tiles && <div className="ckempty">Reading four leagues…</div>}
        {!err && tiles && (
          <div className="ckwrap">
            {tab === 'now' && (nbaOpen
              ? <NbaLeague key={nbaOpen} id={nbaOpen} onBack={() => openNba(null)} />
              : openLeague
              ? <League id={openLeague} onBack={() => setOpenLeague(null)} />
              : <Now tiles={tiles} onOpen={setOpenLeague} onOpenNba={openNba} marks={marks} closeCalls={closeCalls} nba={nba}
                     sport={sport} setSport={setSport} need={needBy} yahooOff={yahooOff} />)}
            {tab === 'news' && <>
              {both && <SportBar on={shown} set={setSport} need={needBy} />}
              {fb && bb && <SportHead sport="nfl" />}
              {fb && <NewsTab news={news} alerts={alerts} onRead={markRead} />}
              {fb && bb && <SportHead sport="nba" />}
              {bb && <NbaNews views={nbaAll.views} open={(id) => openNba(id)} />}
            </>}
            {tab === 'plan' && <>
              {both && <SportBar on={shown} set={setSport} need={needBy} />}
              {fb && bb && <SportHead sport="nfl" />}
              {fb && <MovesTab tiles={tiles} />}
              {fb && bb && <SportHead sport="nba" />}
              {bb && <NbaMoves views={nbaAll.views} open={(id) => openNba(id)} />}
            </>}
            {tab === 'settings' && <Settings sources={sources} />}
          </div>
        )}
        {/* Inside the scrolling region, so it is the foot of the page rather
            than a bar competing with the draft strip for the bottom edge.
            Shown only where Yahoo's data is — see yahooShown. */}
        {yahooShown && <Attribution />}
      </main>
      {/* A draft in progress follows you everywhere, so stepping out is safe. */}
      {!live && nbaAll.drafts[0] && (
        <a className="ckdraftbar" href={`/nba/draft/${nbaAll.drafts[0].id}`}>
          <span className="ckdot" />
          <span className="ckdtx"><b>{nbaAll.drafts[0].label}</b>{nbaAll.drafts[0].mock ? 'Mock draft in progress' : 'Draft in progress'}</span>
          <span className="ckdgo">Resume</span>
        </a>
      )}
      {live && (
        <a className="ckdraftbar" href={`/draft?league=${live.id}`}>
          <span className="ckdot" />
          <span className="ckdtx"><b>{live.label}</b>Draft in progress</span>
          <span className="ckdgo">Resume</span>
        </a>
      )}
    </div>
  )
}

/**
 * Locked only where there is something to lock. Running on this Mac there is no
 * token set and nothing to defend against, so the gate never appears.
 */
function Root() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    fetch('/api/auth/passkey/state')
      .then((r) => r.json())
      .then((s) => setOpen(!s.needsToken))
      .catch(() => setOpen(true))
  }, [])
  if (open === null) return <div className="ckempty">…</div>
  return open ? <Cockpit /> : <Lock onIn={() => setOpen(true)} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
