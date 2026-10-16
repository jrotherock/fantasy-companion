import { useEffect, useState } from 'react'

type Size = { teams: number; configured: number | null; yahoo: number | null; mock: boolean }

/**
 * How many teams the league drafts with, and a switch for it when Yahoo's count differs from the
 * league's own setting (a league that does not fill). Changing it works every number out again; no
 * deploy. Hidden for a mock, which takes its size from its own room.
 */
export function LeagueSize({ leagueId, onChange }: { leagueId: string; onChange?: () => void }) {
  const [size, setSize] = useState<Size | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = () => fetch(`/api/nba/draft/${leagueId}/teams`).then((r) => (r.ok ? r.json() : null)).then((x) => x && setSize(x)).catch(() => {})
  useEffect(() => { load() }, [leagueId])
  if (!size || size.mock) return null
  const options = [...new Set([size.configured, size.yahoo, size.teams].filter((n): n is number => n != null))].sort((a, b) => a - b)
  const off = size.yahoo != null && size.yahoo !== size.teams
  const choose = async (n: number) => {
    if (n === size.teams || busy) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/nba/draft/${leagueId}/teams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teams: n === size.configured ? null : n }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      await load()
      onChange?.()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className={`lsize${off ? ' off' : ''}`}>
      <span className="lsize-label">Teams</span>
      {options.map((n) => (
        <button key={n} className={`lsize-btn${n === size.teams ? ' on' : ''}`} disabled={busy} onClick={() => choose(n)}
          title={n === size.configured ? 'The league’s own setting' : n === size.yahoo ? 'What Yahoo has now' : ''}>{n}</button>
      ))}
      <select className="lsize-other" value="" disabled={busy} aria-label="Another number of teams" onChange={(e) => e.target.value && choose(Number(e.target.value))}>
        <option value="">other…</option>
        {Array.from({ length: 17 }, (_, i) => i + 4).filter((n) => !options.includes(n)).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span className="lsize-note">
        {size.yahoo == null ? 'Yahoo’s count is not readable right now'
          : off ? `Yahoo has ${size.yahoo} teams now; the companion is set to ${size.teams}. Switch if that is how the league will draft.`
          : `Yahoo has ${size.yahoo} too.`}
      </span>
      {err && <span className="lsize-err">{err}</span>}
    </div>
  )
}
