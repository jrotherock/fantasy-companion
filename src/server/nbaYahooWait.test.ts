import { test } from 'node:test'
import assert from 'node:assert/strict'

const { predraftWait } = await import('./nbaYahoo.js')
const MIN = 60_000, HOUR = 60 * MIN

test('before a draft the reader wakes for its start, not an hour after it', () => {
  const start = Date.parse('2026-10-17T02:30:00Z')
  // Harker, 2026-10-16: a look at 7:25 with no order posted slept an hour and missed the 7:30 start.
  assert.equal(predraftWait(start - 5 * MIN, start, false), 30_000)
  assert.equal(predraftWait(start + 2 * MIN, start, false), 30_000, 'late or running: keep looking')
  assert.equal(predraftWait(start - 3 * HOUR, start, false), HOUR, 'hours away: hourly')
  assert.equal(predraftWait(start - 40 * MIN, start, false), 25 * MIN, 'wakes a quarter of an hour before')
  assert.equal(predraftWait(start - 3 * HOUR, null, false), 2 * MIN, 'no scheduled time: every two minutes')
  assert.equal(predraftWait(start - 3 * HOUR, start, true), 2 * MIN, 'order posted: every two minutes')
})
