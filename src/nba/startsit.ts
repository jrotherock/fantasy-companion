/**
 * Start/sit: two of my players on a day, which to start and how sure. Judged as the lineup is: in a category league
 * by what each one's line does for this week's matchup (the chance of winning it, and the categories expected), in
 * points by his fantasy points; each at his chance of playing.
 *
 * How sure comes from a backtest (2026-11-04: every pair of players on the same night over 2025, checked on 2026):
 * the gap between two projections, against how often the one projected higher did better. It held in both seasons:
 * a gap under 2 fantasy points is a coin flip, 8-12 is right three times in four, 12+ six in seven. In categories the
 * gap is in standard units of a player-game (a gap of 2-3 over nine categories right seven times in ten), each
 * category weighted by how much it moves this week.
 */
import { gameToday, weekValue, type Context, type LineupRow, type Snapshot } from './inseason.js'
import { groupOf, oppFactor, OPP_STRENGTH } from './opponent.js'
import { emptyBox, type Box } from './yahooSeason.js'
import type { Cat } from './value.js'

/** A player-game's spread in each category (2025, players of 15+ minutes), shooting by makes over a par rate. */
export const CAT_SD: Record<Cat, number> = { pts: 8.62, tpm: 1.57, reb: 3.35, ast: 2.67, stl: 1.03, blk: 0.85, to: 1.45, fg: 1.59, ft: 0.72 }
const FG_PAR = 0.47, FT_PAR = 0.78
/**
 * The spread of the gap between two players' nights, fitted to the backtest: the chance the one projected higher
 * does better is Φ(gap / spread). In fantasy points (Harker's scoring); in categories, standard units summed over
 * nine equally weighted categories.
 */
export const FP_GAP_SD = 15
export const CAT_GAP_SD = 5

export type Sureness = 'coin flip' | 'lean' | 'fairly sure' | 'confident' | 'clear'
export const surenessOf = (chance: number): Sureness => (chance >= 0.995 ? 'clear' : chance >= 0.78 ? 'confident' : chance >= 0.65 ? 'fairly sure' : chance >= 0.55 ? 'lean' : 'coin flip')

export interface StartSitSide {
  id: string; name: string; team: string | null
  game: { vs: string; home: boolean; tip: string | null } | null
  play: number; status: string
  /** His line that day, as the lineup sees it (before his chance of playing). */
  line: Box | null; min: number | null
  /** What the line is worth: to the week (categories), in fantasy points, or overall when the week has nothing left. */
  value: number
  /** Tonight's opponent against the league for his kind of player, in points a minute (1.05: 5% more). */
  matchup: number | null
}

export interface StartSit {
  date: string
  a: StartSitSide; b: StartSitSide
  /** Who to start; null when neither plays. */
  pick: string | null
  /** The chance the pick turns out the better start. */
  chance: number
  sureness: Sureness
  /** What the call rests on: this week's races, fantasy points, or overall value with no week to play for. */
  basis: 'week' | 'points' | 'overall'
  headline: string
  reasons: string[]
  /** What would turn it around, where something plausible would. */
  flip: string | null
  /** When the first of the two locks. */
  lock: string | null
}

const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y }
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const CATS: Cat[] = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to']
const LABEL: Record<Cat, string> = { fg: 'FG%', ft: 'FT%', tpm: '3s', pts: 'points', reb: 'rebounds', ast: 'assists', stl: 'steals', blk: 'blocks', to: 'turnovers' }
/** A line in standard units, category by category (turnovers counted against). */
const units = (b: Box): Record<Cat, number> => ({
  pts: b.pts / CAT_SD.pts, tpm: b.tpm / CAT_SD.tpm, reb: b.reb / CAT_SD.reb, ast: b.ast / CAT_SD.ast, stl: b.stl / CAT_SD.stl, blk: b.blk / CAT_SD.blk,
  to: -b.to / CAT_SD.to, fg: (b.fgm - FG_PAR * b.fga) / CAT_SD.fg, ft: (b.ftm - FT_PAR * b.fta) / CAT_SD.ft,
})
/** A line worth one standard unit in a category and nothing else. */
function unitLine(c: Cat): Box {
  const b = emptyBox()
  if (c === 'fg') { b.fgm = CAT_SD.fg; b.fga = 0 } else if (c === 'ft') { b.ftm = CAT_SD.ft; b.fta = 0 } else if (c === 'to') b.to = -CAT_SD.to
  else b[c] = CAT_SD[c]
  return b
}

export function startSit(ctx: Context, snap: Snapshot, myTeamId: string, date: string, aId: string, bId: string): StartSit {
  const { schedule } = ctx.world
  const points = ctx.league.scoring === 'points'
  const side = (id: string): StartSitSide => {
    const p = ctx.byId.get(id)
    const g = p ? gameToday(schedule, p.team, date) : null
    const o = g ? ctx.outlook(id, date) : null
    const prior = ctx.world.opponentPrior ?? null, strength = ctx.world.opponentStrength ?? OPP_STRENGTH
    return {
      id, name: p?.name ?? id, team: p?.team ?? null, game: g, play: g ? ctx.play(id, date) : 0, status: ctx.designation(id),
      line: o?.box ?? null, min: o?.min ?? null, value: 0,
      matchup: g && p && strength > 0 ? oppFactor(ctx.allowed, prior, g.vs, groupOf(p.positions), 'pts', strength) : null,
    }
  }
  const a = side(aId), b = side(bId)
  const lock = [a.game?.tip, b.game?.tip].filter((x): x is string => !!x).sort()[0] ?? null
  const base = { date, a, b, lock }
  const plays = (s: StartSitSide) => !!s.game && s.play > 0 && !!s.line
  if (!plays(a) || !plays(b)) {
    const why = (s: StartSitSide) => (!s.game ? `${s.name} has no game` : `${s.name} is ${s.status}`)
    if (!plays(a) && !plays(b)) return { ...base, pick: null, chance: 0.5, sureness: 'coin flip', basis: points ? 'points' : 'week', headline: `Neither plays: ${why(a)}, ${why(b)}`, reasons: [], flip: null }
    const [s, o] = plays(a) ? [a, b] : [b, a]
    return { ...base, pick: s.id, chance: 1, sureness: 'clear', basis: points ? 'points' : 'week', headline: `Start ${s.name}: ${why(o)}`, reasons: [], flip: null }
  }

  // weekValue keeps each row's worth by id: every line gets its own.
  let n = 0
  const row = (line: Box, play: number): LineupRow => ({ id: `startsit:${n++}`, game: { vs: '', home: true, tip: null, started: false, final: false, score: null, status: null, won: null, played: null }, tonight: line, play } as unknown as LineupRow)
  let basis: StartSit['basis'], gapSd: number
  const reasons: string[] = []
  const r1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1)
  if (points) {
    const fp = (line: Box) => Object.entries(ctx.league.points ?? {}).reduce((t, [k, w]) => t + (w ?? 0) * (line[k as keyof Box] ?? 0), 0)
    a.value = fp(a.line!) * a.play; b.value = fp(b.line!) * b.play
    basis = 'points'; gapSd = FP_GAP_SD
  } else {
    // Each category's weight: what one standard unit of it does for this week.
    const week = weekValue(ctx, snap, myTeamId, date)
    const w = Object.fromEntries(CATS.map((c) => [c, week ? week(row(unitLine(c), 1)) : 0])) as Record<Cat, number>
    const strength = Math.sqrt(CATS.reduce((t, c) => t + w[c] ** 2, 0) / CATS.length)
    if (week && strength > 1e-6) {
      a.value = week(row(a.line!, a.play)); b.value = week(row(b.line!, b.play))
      basis = 'week'; gapSd = CAT_GAP_SD * strength
      // What decides it: the categories where the gap does most for the week, and the ones that barely count.
      const ua = units(a.line!), ub = units(b.line!)
      const top = Math.max(...CATS.map((c) => w[c]))
      const parts = CATS.map((c) => ({ c, d: w[c] * (ua[c] * a.play - ub[c] * b.play), raw: ua[c] * a.play - ub[c] * b.play, live: w[c] >= top * 0.25 }))
      const winner = a.value >= b.value ? 1 : -1
      const forPick = parts.filter((x) => x.d * winner > 0 && x.live).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3)
      const dead = parts.filter((x) => !x.live && x.raw * winner < 0 && Math.abs(x.raw) >= 0.3)
      if (forPick.length) reasons.push(`${(winner > 0 ? a : b).name} helps where this week is still open: ${andList(forPick.map((x) => LABEL[x.c]))}`)
      if (dead.length) reasons.push(`${(winner > 0 ? b : a).name}'s edge in ${andList(dead.map((x) => LABEL[x.c]))} barely counts: decided this week`)
    } else {
      // Nothing left in the week to move: overall value, every category the same.
      const v = (line: Box, play: number) => CATS.reduce((t, c) => t + units(line)[c], 0) * play
      a.value = v(a.line!, a.play); b.value = v(b.line!, b.play)
      basis = 'overall'; gapSd = CAT_GAP_SD
      reasons.push(week ? "This week's categories are settled, so this goes by overall value" : 'No matchup that day, so this goes by overall value')
    }
  }
  const [pk, ot] = a.value >= b.value ? [a, b] : [b, a]
  const gap = pk.value - ot.value
  const chance = Phi(gap / gapSd)
  const sureness = surenessOf(chance)
  // The line, side by side.
  const lineWord = (s: StartSitSide) => points
    ? `${s.name} ${r1(s.value)} FP`
    : `${s.name} ${Math.round(s.line!.pts)} pts, ${r1(s.line!.tpm)} 3s, ${r1(s.line!.reb)} reb, ${r1(s.line!.ast)} ast, ${r1(s.line!.stl)} stl, ${r1(s.line!.blk)} blk, ${r1(s.line!.to)} TO${s.line!.fga > 0 ? `, ${Math.round((100 * s.line!.fgm) / s.line!.fga)}% FG` : ''}`
  reasons.unshift(`${lineWord(pk)} · ${lineWord(ot)}`)
  if (pk.min != null && ot.min != null && Math.abs(pk.min - ot.min) >= 2) reasons.push(`Minutes: ${Math.round(pk.min)} for ${pk.name} against ${Math.round(ot.min)}`)
  for (const s of [pk, ot]) if (s.matchup != null && Math.abs(s.matchup - 1) >= 0.03) reasons.push(`${s.name} vs ${s.game!.vs}: ${s.matchup > 1 ? 'a soft' : 'a tough'} matchup (${s.matchup > 1 ? '+' : '−'}${Math.round(Math.abs(s.matchup - 1) * 100)}% points)`)
  for (const s of [pk, ot]) if (s.play < 0.9) reasons.push(`${s.name} is ${s.status}: counted at a ${Math.round(s.play * 100)}% chance to play`)
  // What would turn it: the pick's minutes falling to where his line is worth no more than the other's.
  // A coin flip turns on anything: nothing to name.
  let flip: string | null = null
  if (sureness === 'coin flip') flip = null
  else if (pk.play < 0.9) flip = `If ${pk.name} is ruled out, start ${ot.name}`
  else if (pk.value > 0 && ot.value > 0 && pk.min) {
    const f = ot.value / pk.value
    if (f >= 0.6 && f < 1) flip = `Would flip if ${pk.name} plays under ${Math.floor(pk.min * f)} minutes`
  }
  const pctWord = `${Math.round(chance * 100)}%`
  // How sure is shown beside it in words; the headline gives the call and its chance.
  const headline = sureness === 'coin flip' ? `${pk.name} by a hair over ${ot.name} (${pctWord})` : `Start ${pk.name} over ${ot.name} (${pctWord})`
  return { ...base, pick: pk.id, chance, sureness, basis, headline, reasons, flip }
}
