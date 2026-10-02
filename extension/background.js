/*
 * Bridges the content script to the local companion.
 *
 * The content script can read Yahoo but cannot POST to http://localhost from an
 * HTTPS page. The extension can, so every write goes through here.
 */

/*
 * Where the companion lives, and how to prove we are allowed to talk to it.
 *
 * Hosted, the companion is guarded and this cannot use Face ID — an extension
 * has no way to perform WebAuthn — so it presents the token instead. That is
 * the job the token keeps once passkeys handle the browser: machine access.
 *
 * Set both from the extension's popup; they persist across restarts.
 */
/*
 * More than one companion, because there is no reason to choose.
 *
 * The laptop copy is what you draft against — no network hop, no cold start,
 * nothing to be down at half past eight on a Sunday. The hosted copy is what
 * keeps watching when the laptop is shut. A roster read off a Yahoo page is
 * worth having in both, and they hold their own state, so sending it twice
 * costs nothing and keeps them from disagreeing.
 *
 * Writes go to every target; a target that is down or unreachable fails on its
 * own without taking the others with it. Reads take the first that answers.
 */
/*
 * Targets are read at the moment of sending, not cached in a variable.
 *
 * A manifest v3 worker is torn down whenever it goes idle and started again by
 * the very message it has to handle. Populating a module-level list from an
 * asynchronous storage read meant the first push after every wake — which is
 * most of them — went out against the default, localhost alone, and the hosted
 * companion never heard a thing. It looked exactly like a configuration
 * problem, which is why I went looking for one.
 */
const DEFAULT_TARGET = { base: 'http://localhost:4600', token: '' }

async function targets() {
  try {
    const v = await chrome.storage.local.get(['base', 'token', 'base2', 'token2'])
    const out = []
    const primary = String(v?.base || DEFAULT_TARGET.base).replace(/\/+$/, '')
    if (primary) out.push({ base: primary, token: String(v?.token || '') })
    const second = String(v?.base2 || '').replace(/\/+$/, '')
    if (second) out.push({ base: second, token: String(v?.token2 || v?.token || '') })
    return out.length ? out : [DEFAULT_TARGET]
  } catch {
    return [DEFAULT_TARGET]
  }
}

const authFor = (t, extra) =>
  t.token ? { ...extra, authorization: `Bearer ${t.token}` } : { ...extra }

/**
 * Send to every companion. One being unreachable is normal — the laptop is
 * often asleep, the hosted one is occasionally redeploying — so a failure is
 * recorded and the others still get the push.
 */
async function fanOut(path, init) {
  const list = await targets()
  const results = await Promise.all(list.map(async (t) => {
    try {
      const res = await fetch(`${t.base}${path}`, {
        ...init,
        headers: authFor(t, init && init.headers),
      })
      let body = null
      try { body = await res.json() } catch { /* not every reply is JSON */ }
      return { base: t.base, ok: res.ok, status: res.status, body }
    } catch (e) {
      return { base: t.base, ok: false, status: 0, error: String(e && e.message) }
    }
  }))
  recordTargets(results)
  const sent = results.filter((r) => r.ok)
  return {
    ok: sent.length > 0,
    sent: sent.map((r) => r.base),
    failed: results.filter((r) => !r.ok).map((r) => r.base),
    // Callers want the companion's own answer; any that succeeded will do,
    // since they are told the same thing and resolve it the same way.
    body: sent[0]?.body ?? null,
    error: results.find((r) => !r.ok)?.error ?? null,
  }
}

/** Reads only need one answer, so take the first target that gives one. */
async function readFirst(path) {
  let last = null
  for (const t of await targets()) {
    try {
      const res = await fetch(`${t.base}${path}`, { headers: authFor(t) })
      if (res.ok) return res
      last = new Error(`companion HTTP ${res.status}`)
    } catch (e) { last = e }
  }
  throw last || new Error('no companion reachable')
}

/*
 * Per-target results, because "nothing loaded" is not a diagnosis.
 *
 * With one address a single connected flag was enough. With two, the useful
 * question is which one got it — and the answer was invisible: the extension
 * pushed happily to the laptop while the hosted copy sat empty, and there was
 * nothing on screen to say so.
 */
let status = { connected: false, lastPush: null, lastError: null, counts: {}, targets: [] }

function recordTargets(results) {
  status.targets = results.map((r) => ({
    base: r.base,
    ok: r.ok,
    detail: r.ok ? `${r.status}` : (r.error || `HTTP ${r.status}`),
    at: Date.now(),
  }))
}

async function leagues() {
  const res = await readFirst('/api/leagues')
  if (!res.ok) throw new Error(`companion HTTP ${res.status}`)
  const all = await res.json()
  // Only Yahoo leagues, paired with the numeric id the results page uses.
  const football = all
    .filter((l) => l.platform === 'yahoo')
    .map((l) => ({
      leagueId: l.id,
      label: l.label,
      sport: 'nfl',
      yahooLeagueId: String(l.leagueKey || '').split('.').pop() || l.leagueId,
      teamId: l.myTeamId || null,
      // How often to ask, and which page to read — decided by the companion,
      // which is the side that can see a clock and a schedule.
      sensor: l.sensor || null,
    }))
  /*
   * Basketball leagues come from their own list, with the page to read and
   * the site it lives on, since Yahoo serves basketball from another host.
   * A companion too old to have the list simply has no basketball.
   */
  let basketball = []
  try {
    const nba = await readFirst('/api/nba/leagues')
    if (nba.ok) {
      basketball = (await nba.json()).map((l) => ({
        leagueId: l.id,
        label: l.label,
        sport: 'nba',
        yahooLeagueId: String(l.leagueKey || '').split('.').pop(),
        teamId: null,
        sensor: l.sensor || null,
      }))
    }
  } catch { /* no basketball on this companion */ }
  return [...football, ...basketball]
}

/** Replying to a closed port throws; the sender has simply gone away. */
function safeReply(reply, value) {
  try {
    reply(value)
  } catch {
    // Nothing to do — the tab or popup that asked is no longer listening.
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'yahooRoster') {
    // A roster is worth having in both companions; whichever is up gets it.
    fanOut('/api/cockpit/yahoo-roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    })
      .then((out) => safeReply(reply, out.body ?? { ok: out.ok }))
      .catch((err) => safeReply(reply, { ok: false, error: String(err) }))
    return true
  }

  if (msg.type === 'leagues') {
    leagues()
      .then((list) => {
        status.connected = true
        status.lastError = null
        safeReply(reply, { leagues: list })
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { leagues: null, error: status.lastError })
      })
    return true
  }

  if (msg.type === 'detected') {
    fanOut(`/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'yahoo',
        yahooLeagueId: msg.yahooLeagueId,
        teamId: msg.teamId,
        shape: msg.shape,
        rows: msg.rows,
      }),
    })
      .then((out) => {
        const json = out.body ?? {}
        status.connected = out.ok
        status.lastPush = Date.now()
        status.lastError = out.failed.length ? `not reached: ${out.failed.join(', ')}` : null
        if (json.leagueId) status.counts[json.leagueId] = json.accepted ?? 0
        safeReply(reply, json)
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { ok: false })
      })
    return true
  }

  if (msg.type === 'snapshot') {
    // Must return true and reply only once the fetch settles. Returning false
    // lets Chrome tear the service worker down mid-request, which silently
    // drops the push — the sensor looks alive and nothing ever arrives.
    fanOut(msg.sport === 'nba' ? `/api/nba/draft/${msg.leagueId}/yahoo` : `/api/league/${msg.leagueId}/yahoo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.sport === 'nba' ? { rows: msg.rows, order: msg.order || [] } : { rows: msg.rows, shape: msg.shape }),
    })
      .then((out) => {
        const json = out.body ?? {}
        status.connected = out.ok
        status.lastPush = Date.now()
        status.counts[msg.leagueId] = json.accepted ?? 0
        status.lastError = json.unresolved?.length
          ? `${json.unresolved.length} unresolved: ${json.unresolved.slice(0, 3).join(', ')}`
          : out.failed.length ? `not reached: ${out.failed.join(', ')}` : null
        safeReply(reply, { ok: out.ok, accepted: json.accepted ?? 0 })
      })
      .catch((err) => {
        status.connected = false
        status.lastError = String(err.message || err)
        safeReply(reply, { ok: false, error: status.lastError })
      })
    return true
  }

  if (msg.type === 'error') {
    status.lastError = `${msg.leagueId}: ${msg.message}`
    // Forward to the companion so its health badge tells the truth.
    fanOut(msg.sport === 'nba' ? `/api/nba/draft/${msg.leagueId}/yahoo` : `/api/league/${msg.leagueId}/yahoo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: msg.message }),
    })
      .then(() => safeReply(reply, { ok: true }))
      .catch(() => safeReply(reply, { ok: false }))
    return true
  }

  /*
   * Ask each companion directly, on demand.
   *
   * Reading the stored settings back is the one thing that cannot be done from
   * outside the extension, and a green dot from an earlier push does not prove
   * the address is still right. This hits every configured target now and says
   * what each one answered.
   */
  if (msg.type === 'ping') {
    targets().then(async (list) => {
      const rows = await Promise.all(list.map(async (t) => {
        const started = Date.now()
        try {
          const res = await fetch(`${t.base}/api/health`, { headers: authFor(t) })
          const body = await res.json().catch(() => null)
          return {
            base: t.base,
            hasToken: !!t.token,
            ok: res.ok,
            detail: res.ok
              ? `${body?.leagues ?? '?'} leagues · ${Math.round(Date.now() - started)}ms`
              : `HTTP ${res.status}`,
          }
        } catch (e) {
          return { base: t.base, hasToken: !!t.token, ok: false, detail: String(e && e.message) }
        }
      }))
      safeReply(reply, { targets: rows })
    })
    return true
  }

  if (msg.type === 'status') {
    // Show what is configured even when nothing has been pushed yet, so an
    // unset second companion is visible rather than merely absent.
    targets().then((list) => {
      const known = new Set(status.targets.map((t) => t.base))
      const shown = [
        ...status.targets,
        ...list.filter((t) => !known.has(t.base))
          .map((t) => ({ base: t.base, ok: null, detail: 'nothing sent yet', at: null })),
      ]
      safeReply(reply, { ...status, targets: shown })
    })
    return true
    return true
  }
  return false
})
