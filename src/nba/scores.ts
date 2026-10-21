/**
 * Tonight's games as they stand: score, period and clock, for the Today screen's "Final (W) 106-100" and
 * "Q2 4:12" (2026-10-21: asked for, as Yahoo's matchup page shows them). Yahoo's data has neither; the NBA's own
 * feed refuses requests from outside nba.com, so this reads ESPN's public scoreboard
 * (site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD). Scores and the clock only:
 * nothing else of ESPN's is used.
 */
import { teamCode } from './inseason.js'

export interface LiveGame {
  home: string
  away: string
  homeScore: number
  awayScore: number
  /** ESPN's state: before tip, in progress, over. */
  state: 'pre' | 'in' | 'post'
  period: number
  /** The game clock in the period, "4:12"; "0.0" at a period's end. */
  clock: string
  /** ESPN's own short status: "Final", "Final/OT", "Halftime", "End of 1st", "4:12 - 2nd", "10/21 - 7:00 PM EDT". */
  detail: string
}

export function parseEspnScoreboard(json: any): LiveGame[] {
  const out: LiveGame[] = []
  for (const e of json?.events ?? []) {
    const c = e?.competitions?.[0]
    const s = e?.status ?? c?.status
    const home = c?.competitors?.find((t: any) => t?.homeAway === 'home'), away = c?.competitors?.find((t: any) => t?.homeAway === 'away')
    const state = s?.type?.state
    if (!home || !away || !['pre', 'in', 'post'].includes(state)) continue
    out.push({
      home: teamCode(home.team?.abbreviation ?? null) ?? '', away: teamCode(away.team?.abbreviation ?? null) ?? '',
      homeScore: Number(home.score) || 0, awayScore: Number(away.score) || 0,
      state, period: Number(s.period) || 0, clock: String(s.displayClock ?? ''), detail: String(s.type?.shortDetail ?? ''),
    })
  }
  return out
}

/** A game from one team's side: its score first, the other's second, and where the game stands in a few words. */
export interface TeamGame { us: number; them: number; state: LiveGame['state']; status: string; won: boolean | null; played: number | null }

const periodWord = (p: number) => (p <= 4 ? `Q${p}` : p === 5 ? 'OT' : `${p - 4}OT`)
const clockMinutes = (c: string) => { const [m, s] = c.split(':'); return s == null ? Number(m) / 60 : Number(m) + Number(s) / 60 }

export function teamGame(games: LiveGame[], team: string | null): TeamGame | null {
  const g = team ? games.find((x) => x.home === team || x.away === team) : null
  if (!g) return null
  const home = g.home === team
  const us = home ? g.homeScore : g.awayScore, them = home ? g.awayScore : g.homeScore
  if (g.state === 'pre') return { us, them, state: g.state, status: '', won: null, played: 0 }
  if (g.state === 'post') return { us, them, state: g.state, status: g.detail || 'Final', won: us > them, played: 1 }
  const status = /half/i.test(g.detail) ? 'Half' : /^end/i.test(g.detail) ? `End ${periodWord(g.period)}` : `${periodWord(g.period)} ${g.clock}`
  // The share of a regulation game played: twelve-minute quarters, five-minute overtimes counted as the end.
  const left = Number.isFinite(clockMinutes(g.clock)) ? clockMinutes(g.clock) : 0
  const played = g.period <= 4 ? Math.max(0, Math.min(1, ((g.period - 1) * 12 + (12 - left)) / 48)) : 1
  return { us, them, state: g.state, status, won: null, played }
}
