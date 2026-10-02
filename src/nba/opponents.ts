/**
 * How the people in a league draft, from its own history.
 *
 * Three habits, each measured per manager per season:
 *   reach       how far ahead of that season's preseason ADP they take
 *               players in the first eight rounds (positive: earlier)
 *   bigEarly    share of their first six picks who can play centre
 *   guardEarly  share of their first six picks who can play point guard
 *
 * A habit is only worth showing if it holds. So each one is tested at the
 * league level first: does a manager's average over earlier seasons predict
 * the latest one? Football's lesson was that habits which looked real in one
 * draft did not survive another; in basketball's first look, with three
 * seasons, most did not either. A habit is called consistent only where that
 * test passes, and is otherwise shown — if at all — as unproven.
 *
 * Managers are the people (Yahoo nicknames, matched regardless of case), not
 * team names, which change every year. Seasons Yahoo hides managers in
 * contribute nothing. Profiles are keyed by `personKey`.
 */

export type Metric = 'reach' | 'bigEarly' | 'guardEarly'
export const METRICS: Metric[] = ['reach', 'bigEarly', 'guardEarly']

export interface HistPick {
  pick: number
  round: number
  manager: string | null
  positions: string[]
  adp: number | null
}

export interface HistSeason {
  season: string
  teams: number
  picks: HistPick[]
}

export interface Habit {
  metric: Metric
  text: string
  consistent: boolean
}

export interface ManagerProfile {
  seasons: number
  metrics: Record<Metric, number>
  habits: Habit[]
}

export interface OpponentReport {
  seasons: string[]
  validation: Record<Metric, { managers: number; priorPredictsLast: number; yearToYear: number; pairs: number; consistent: boolean }>
  managers: Record<string, ManagerProfile>
  leagueMean: Record<Metric, number>
}

/** One person however Yahoo capitalised their nickname that year. */
export const personKey = (nickname: string) => nickname.trim().toLowerCase()

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
export function corr(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys)
  let n = 0, a = 0, b = 0
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); a += (xs[i] - mx) ** 2; b += (ys[i] - my) ** 2 }
  return a && b ? n / Math.sqrt(a * b) : 0
}

/** One manager's habits in one season; null where the season cannot say (no ADP for reach). */
export function seasonMetrics(picks: HistPick[]): Partial<Record<Metric, number>> {
  const early = picks.filter((p) => p.round <= 6 && p.positions.length)
  const mid = picks.filter((p) => p.round <= 8 && p.adp != null)
  const out: Partial<Record<Metric, number>> = {}
  if (mid.length >= 4) out.reach = mean(mid.map((p) => p.adp! - p.pick))
  if (early.length >= 4) {
    out.bigEarly = mean(early.map((p) => (p.positions.includes('C') ? 1 : 0)))
    out.guardEarly = mean(early.map((p) => (p.positions.includes('PG') ? 1 : 0)))
  }
  return out
}

/** Thresholds a habit must clear to be called consistent: it has to predict the held-out season. */
const PREDICTS = 0.4
const MIN_MANAGERS = 6

export function analyseOpponents(history: HistSeason[]): OpponentReport {
  const seasons = [...history].sort((a, b) => a.season.localeCompare(b.season))
  const per = new Map<string, Map<string, Partial<Record<Metric, number>>>>()
  for (const s of seasons) {
    const by = new Map<string, HistPick[]>()
    for (const p of s.picks) if (p.manager) by.set(personKey(p.manager), [...(by.get(personKey(p.manager)) ?? []), p])
    per.set(s.season, new Map([...by].map(([m, ps]) => [m, seasonMetrics(ps)])))
  }

  const validation = {} as OpponentReport['validation']
  const leagueMean = {} as Record<Metric, number>
  for (const k of METRICS) {
    // Year to year, across every consecutive pair a manager appears in.
    const xs: number[] = [], ys: number[] = []
    for (let i = 1; i < seasons.length; i++) {
      for (const [m, b] of per.get(seasons[i].season)!) {
        const a = per.get(seasons[i - 1].season)!.get(m)
        if (a?.[k] != null && b[k] != null) { xs.push(a[k]!); ys.push(b[k]!) }
      }
    }
    // The test that matters at a draft: everything before the latest season, against the latest.
    const last = seasons.at(-1)
    const px: number[] = [], py: number[] = []
    if (last) {
      for (const [m, now] of per.get(last.season)!) {
        if (now[k] == null) continue
        const before = seasons.slice(0, -1).map((s) => per.get(s.season)!.get(m)?.[k]).filter((v): v is number => v != null)
        if (before.length) { px.push(mean(before)); py.push(now[k]!) }
      }
    }
    const priorPredictsLast = corr(px, py)
    validation[k] = {
      managers: px.length, priorPredictsLast, yearToYear: corr(xs, ys), pairs: xs.length,
      consistent: px.length >= MIN_MANAGERS && priorPredictsLast >= PREDICTS,
    }
    leagueMean[k] = mean([...per.values()].flatMap((m) => [...m.values()].map((v) => v[k]).filter((v): v is number => v != null)))
  }

  // Profiles: each manager's average, and a habit where they stand well apart from the league.
  const all = new Map<string, Partial<Record<Metric, number>>[]>()
  for (const m of per.values()) for (const [who, v] of m) all.set(who, [...(all.get(who) ?? []), v])
  const spread = Object.fromEntries(METRICS.map((k) => [k, sd([...all.values()].map((vs) => mean(vs.map((v) => v[k]).filter((x): x is number => x != null))))])) as Record<Metric, number>

  const managers: Record<string, ManagerProfile> = {}
  for (const [who, vs] of all) {
    const metrics = Object.fromEntries(METRICS.map((k) => [k, mean(vs.map((v) => v[k]).filter((x): x is number => x != null))])) as Record<Metric, number>
    const habits: Habit[] = []
    if (vs.length >= 3) {
      for (const k of METRICS) {
        const gap = metrics[k] - leagueMean[k]
        if (!spread[k] || Math.abs(gap) < spread[k]) continue
        const consistent = validation[k].consistent
        const text =
          k === 'reach' ? (gap > 0 ? `reaches — about ${Math.round(metrics[k])} picks ahead of ADP` : `waits — takes players about ${Math.round(-metrics[k])} picks after ADP`)
          : k === 'bigEarly' ? `${gap > 0 ? 'loads up on' : 'avoids'} centres early (${Math.round(metrics[k] * 100)}% of first six picks; league ${Math.round(leagueMean[k] * 100)}%)`
          : `${gap > 0 ? 'takes point guards early' : 'leaves point guards'} (${Math.round(metrics[k] * 100)}% of first six; league ${Math.round(leagueMean[k] * 100)}%)`
        habits.push({ metric: k, text, consistent })
      }
    }
    managers[who] = { seasons: vs.length, metrics, habits }
  }
  return { seasons: seasons.map((s) => s.season), validation, managers, leagueMean }
}

// ── Backtest: do habits predict picks better than ADP alone? ─────────────────

export interface BacktestResult {
  seasonsTested: string[]
  picks: number
  /** Mean log-loss per pick (lower is better), and hit rates, for each model. */
  adp: { logloss: number; top1: number; top3: number }
  habits: { logloss: number; top1: number; top3: number }
  /** The same, first six rounds only — where the habits are measured and where survival matters. */
  early: { picks: number; adp: number; habits: number }
  /** Per held-out season: log-loss with and without habits, and the weight learned before it. */
  bySeason: { season: string; picks: number; adp: number; habits: number; weight: number; scale: number }[]
  /** Mean per-pick log-loss saved by habits, and its standard error over the paired picks. */
  gain: { mean: number; se: number }
  verdict: 'habits help' | 'within noise' | 'no better than ADP'
}

interface Cand { adp: number; pg: boolean; c: boolean; idx: number }

/** Probability each candidate is the pick: lower ADP more likely, nudged by the manager's appetite. */
function probs(cands: Cand[], scale: number, w: number, guardDev: number, centreDev: number, early: boolean): number[] {
  const logits = cands.map((x) => -x.adp / scale + (early ? w * ((x.pg ? guardDev : 0) + (x.c ? centreDev : 0)) : 0))
  const m = Math.max(...logits)
  const e = logits.map((l) => Math.exp(l - m))
  const z = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / z)
}

/** Each manager's appetite for point guards and centres in their first six picks, relative to the league, from these seasons only. */
function appetites(train: HistSeason[]) {
  const shares = new Map<string, { g: number[]; c: number[] }>()
  const all = { g: [] as number[], c: [] as number[] }
  for (const s of train) {
    const by = new Map<string, HistPick[]>()
    for (const p of s.picks) if (p.manager && p.round <= 6 && p.positions.length) by.set(personKey(p.manager), [...(by.get(personKey(p.manager)) ?? []), p])
    for (const [m, ps] of by) {
      const g = mean(ps.map((p) => (p.positions.includes('PG') ? 1 : 0))), c = mean(ps.map((p) => (p.positions.includes('C') ? 1 : 0)))
      const e = shares.get(m) ?? { g: [], c: [] }
      e.g.push(g); e.c.push(c); shares.set(m, e)
      all.g.push(g); all.c.push(c)
    }
  }
  const lg = mean(all.g), lc = mean(all.c)
  return (m: string | null) => {
    const e = m ? shares.get(personKey(m)) : undefined
    // Shrunk toward the league by seasons seen: one season of habit is mostly noise.
    const k = e ? e.g.length / (e.g.length + 2) : 0
    return e ? { g: k * (mean(e.g) - lg), c: k * (mean(e.c) - lc) } : { g: 0, c: 0 }
  }
}

/** Log-loss and hits over a season's picks, every candidate being whoever was still undrafted. */
function score(s: HistSeason, scale: number, w: number, appetite: ReturnType<typeof appetites>) {
  const picks = [...s.picks].sort((a, b) => a.pick - b.pick)
  const pool: Cand[] = picks.map((p, idx) => ({ adp: p.adp ?? 200, pg: p.positions.includes('PG'), c: p.positions.includes('C'), idx }))
  const out = { ll: 0, top1: 0, top3: 0, n: 0, earlyLl: 0, earlyN: 0, each: [] as number[] }
  for (let i = 0; i < picks.length; i++) {
    const cands = pool.slice(i)
    const a = appetite(picks[i].manager)
    const early = picks[i].round <= 6
    const pr = probs(cands, scale, w, a.g, a.c, early)
    const p = Math.max(pr[0], 1e-9)
    out.ll += -Math.log(p); out.n++; out.each.push(-Math.log(p))
    const rank = pr.filter((q) => q > pr[0]).length
    if (rank === 0) out.top1++
    if (rank < 3) out.top3++
    if (early) { out.earlyLl += -Math.log(p); out.earlyN++ }
  }
  return out
}

/** The ADP scale and habit weight that fit the training seasons best. */
function fit(train: HistSeason[], appetite: ReturnType<typeof appetites>, withHabits: boolean) {
  let best = { scale: 10, w: 0, ll: Infinity }
  for (const scale of [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]) {
    for (const w of withHabits ? [0, 1, 2, 3, 4, 6, 8, 10, 14] : [0]) {
      const ll = train.reduce((n, s) => n + score(s, scale, w, appetite).ll, 0)
      if (ll < best.ll) best = { scale, w, ll }
    }
  }
  return best
}

/**
 * Walk forward: each season from the fourth on is predicted from the seasons
 * before it alone — appetites and fitted weights both — and scored against
 * what was really picked. Habits count as helping only if they lower the
 * held-out log-loss overall and in most seasons.
 */
export function backtestHabits(history: HistSeason[], minTrain = 3): BacktestResult {
  const seasons = [...history].filter((s) => s.picks.length).sort((a, b) => a.season.localeCompare(b.season))
  const tot = { adp: { ll: 0, t1: 0, t3: 0 }, hab: { ll: 0, t1: 0, t3: 0 }, n: 0, early: { a: 0, h: 0, n: 0 } }
  const diffs: number[] = []
  const bySeason: BacktestResult['bySeason'] = []
  for (let i = minTrain; i < seasons.length; i++) {
    const train = seasons.slice(0, i), test = seasons[i]
    const appetite = appetites(train)
    const base = fit(train, appetite, false)
    const hab = fit(train, appetite, true)
    const a = score(test, base.scale, 0, appetite)
    const h = score(test, hab.scale, hab.w, appetite)
    tot.adp.ll += a.ll; tot.adp.t1 += a.top1; tot.adp.t3 += a.top3
    tot.hab.ll += h.ll; tot.hab.t1 += h.top1; tot.hab.t3 += h.top3
    tot.n += a.n
    tot.early.a += a.earlyLl; tot.early.h += h.earlyLl; tot.early.n += a.earlyN
    a.each.forEach((x, k) => diffs.push(x - h.each[k]))
    bySeason.push({ season: test.season, picks: a.n, adp: a.ll / a.n, habits: h.ll / h.n, weight: hab.w, scale: hab.scale })
  }
  const n = Math.max(1, tot.n)
  const wins = bySeason.filter((s) => s.habits < s.adp).length
  // A gain has to stand clear of chance: twice its standard error over the paired picks.
  const g = mean(diffs), se = diffs.length > 1 ? sd(diffs) / Math.sqrt(diffs.length) : Infinity
  return {
    seasonsTested: bySeason.map((s) => s.season),
    picks: tot.n,
    adp: { logloss: tot.adp.ll / n, top1: tot.adp.t1 / n, top3: tot.adp.t3 / n },
    habits: { logloss: tot.hab.ll / n, top1: tot.hab.t1 / n, top3: tot.hab.t3 / n },
    early: { picks: tot.early.n, adp: tot.early.a / Math.max(1, tot.early.n), habits: tot.early.h / Math.max(1, tot.early.n) },
    bySeason,
    gain: { mean: g, se },
    verdict: g <= 0 ? 'no better than ADP' : g > 2 * se && wins > bySeason.length / 2 ? 'habits help' : 'within noise',
  }
}
