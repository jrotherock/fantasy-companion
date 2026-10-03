/**
 * Basketball across both leagues, for the News and Moves tabs.
 *
 * Football's News and Moves are cross-league screens; these are basketball's.
 * A player news item that matters in two leagues is said once, with a chip per
 * league saying what he is there — yours, your opponent's, or free. Moves puts
 * each league's add budget beside its best pickups, then its trade ideas.
 */
import { useState } from 'react'
import type { SeasonView } from '../../../nba/seasonView'
import type { NewsItem } from '../../../nba/news'

const pct = (x: number) => `${Math.round(x * 100)}%`
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000)
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
const WHOSE: Record<string, string> = { mine: 'yours', opponent: 'opponent', free: 'free', other: 'rostered' }
const short = (label: string) => label.replace(/ \(test\)$/, '').replace(/^Harker Fantasy Basketball$/, 'Harker').replace(/^Hoops 2025$/, 'Hoops')

function drafted(views: SeasonView[]) { return views.filter((v) => v.phase === 'season') }

function Empty({ views, what }: { views: SeasonView[]; what: string }) {
  return <div className="ckempty">{views.length ? `No basketball league has drafted yet — ${what} starts with the season.` : 'No basketball leagues.'}</div>
}

export function NbaNews({ views, open }: { views: SeasonView[]; open: (id: string) => void }) {
  const live = drafted(views)
  if (!live.length) return <Empty views={views} what="news" />
  // One line per story, however many leagues it touches.
  const stories = new Map<string, { item: NewsItem; leagues: { id: string; label: string; whose: string }[] }>()
  for (const v of live) for (const n of v.news) {
    // A status change carries its time in its key; the same change seen in two leagues is one story.
    const key = n.kind === 'worse' || n.kind === 'better' ? n.key.replace(/:\d+$/, '') : n.key
    const s = stories.get(key) ?? { item: n, leagues: [] }
    if (!s.leagues.some((l) => l.id === v.league.id)) s.leagues.push({ id: v.league.id, label: v.league.label, whose: n.whose })
    // The story is weighed by the league where it matters most.
    if (n.weight > s.item.weight) s.item = n
    stories.set(key, s)
  }
  const list = [...stories.values()].sort((a, b) => b.item.weight - a.item.weight || (b.item.at ?? 0) - (a.item.at ?? 0))
  const mine = list.filter((s) => s.leagues.some((l) => l.whose === 'mine'))
  const rest = list.filter((s) => !mine.includes(s))
  const Row = ({ s }: { s: (typeof list)[number] }) => (
    <div className={`nl-news ${s.item.kind}`}>
      <div className="nl-newsh">{s.item.headline}</div>
      <div className="nl-dim">{s.item.detail}{s.item.at ? ` · ${ago(s.item.at)}` : ''}</div>
      <div className="nl-chips nl-chiprow">
        {s.leagues.map((l) => <button key={l.id} className={`nl-chip nl-${l.whose}`} onClick={() => open(l.id)}>{short(l.label)}: {WHOSE[l.whose]}</button>)}
      </div>
    </div>
  )
  return (
    <>
      <section className="nl-sect">
        <h2 className="nl-h">Your players<span className="nl-hint">across both leagues</span></h2>
        {!mine.length && <div className="nl-none">Nothing new about your players.</div>}
        {mine.map((s) => <Row key={s.item.key} s={s} />)}
      </section>
      <section className="nl-sect">
        <h2 className="nl-h">Opponents and free agents</h2>
        {!rest.length && <div className="nl-none">Nothing new.</div>}
        {rest.slice(0, 30).map((s) => <Row key={s.item.key} s={s} />)}
      </section>
    </>
  )
}

export function NbaMoves({ views, open }: { views: SeasonView[]; open: (id: string) => void }) {
  const [seg, setSeg] = useState<'Adds' | 'Trades'>('Adds')
  const live = drafted(views)
  if (!live.length) return <Empty views={views} what="adds and trades" />
  return (
    <>
      <div className="ckseg" role="tablist">
        {(['Adds', 'Trades'] as const).map((o) => <button key={o} role="tab" aria-selected={o === seg} className={o === seg ? 'on' : ''} onClick={() => setSeg(o)}>{o}</button>)}
      </div>
      {live.map((v) => {
        const b = v.budget
        return (
          <section key={v.league.id} className="nl-sect">
            <h2 className="nl-h"><button className="nl-link nl-lg" onClick={() => open(v.league.id)}>{v.league.label} ›</button>
              {seg === 'Adds' && b && <span className="nl-hint">{b.week ? `${Math.max(0, b.week.max - b.week.used)}/${b.week.max} this week` : ''}{b.season ? ` · ${Math.max(0, b.season.max - b.season.used)}/${b.season.max} season` : ''}</span>}
            </h2>
            {seg === 'Adds' && (
              <>
                {!v.pickups.length && <div className="nl-none">Nothing on the wire worth an add.</div>}
                {v.pickups.slice(0, 4).map((p, i) => (
                  <div key={p.add} className={`nl-pick${p.kind === 'stream' && b && i >= b.forStreams ? ' over' : ''}`}>
                    <div className="nl-pickh"><span className={`nl-kind ${p.kind}`}>{p.kind}</span><b>Add {p.name}</b> <span className="nl-dim">{p.team} · {p.positions.join('/')}</span>{p.waiver && <span className="nl-stat questionable">waivers</span>}</div>
                    <div className="nl-pickd">{p.dropName && <>Drop {p.dropName} · </>}{p.why} · win {pct(p.winBefore)} → {pct(p.winAfter)}</div>
                  </div>
                ))}
                {b && <p className="nl-note">{b.note}</p>}
              </>
            )}
            {seg === 'Trades' && (
              <>
                {!v.trades.length && <div className="nl-none">{v.playoffs?.daysToDeadline != null && v.playoffs.daysToDeadline < 0 ? 'The trade deadline has passed.' : 'Nothing that helps you without hurting them.'}</div>}
                {v.trades.slice(0, 4).map((t, i) => (
                  <div key={i} className="nl-trade">
                    <div><span className="nl-dim">{t.teamName} ({t.manager}):</span> give <b>{t.give.map((g) => g.name).join(' + ')}</b>, get <b>{t.get.map((g) => g.name).join(' + ')}</b></div>
                    <div className="nl-dim">{t.why}</div>
                  </div>
                ))}
                {v.playoffs?.tradeDeadline && v.playoffs.daysToDeadline != null && v.playoffs.daysToDeadline >= 0 && <p className="nl-note">Trade deadline in {v.playoffs.daysToDeadline} days.</p>}
              </>
            )}
          </section>
        )
      })}
    </>
  )
}
