import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headlinesDue, parseHeadlines, searchUrl } from './headlines.js'

const NOW = Date.parse('2026-11-14T20:00:00Z')
const H = 3_600_000
const item = (title: string, source: string, hoursAgo: number, link = `https://x/${encodeURIComponent(title)}`) =>
  `<item><title>${title} - ${source}</title><link>${link}</link><pubDate>${new Date(NOW - hoursAgo * H).toUTCString()}</pubDate><source url="https://s">${source}</source></item>`

test('headlines: his own, recent, about whether he plays first, newest first, three at most, titles cleaned', () => {
  const xml = `<rss><channel>
    ${item('Bucks&apos; Myles Turner scores 20 in win', 'ESPN', 1)}
    ${item('Myles Turner News: Cleared for Friday', 'RotoWire', 5)}
    ${item('Bucks&#39; Myles Turner: Cleared for Friday', 'CBS Sports', 5)}
    ${item('Final Injury Report for Bucks-Magic: Will Jalen Suggs, Myles Turner Play?', 'Yahoo Sports', 2)}
    ${item('Bucks beat Magic behind Giannis', 'AP', 1)}
    ${item('Myles Turner questionable with ankle sprain', 'The Athletic', 80)}
    ${item('Myles Turner: Will start Friday', 'RotoWire', 3)}
    ${item('Myles Turner: Will start Friday', 'CBS Sports', 3.5)}
    ${item('Myles Turner: Cleared for Friday', 'RotoWire', 4)}
  </channel></rss>`
  const got = parseHeadlines(xml, 'Myles Turner', NOW)
  assert.deepEqual(got.map((h) => [h.source, h.title]), [
    ['Yahoo Sports', 'Final Injury Report for Bucks-Magic: Will Jalen Suggs, Myles Turner Play?'],
    ['RotoWire', 'Myles Turner: Will start Friday'],
    ['RotoWire', 'Myles Turner: Cleared for Friday'],
  ])
  // Past three days, and a headline not naming him, are left out; the same story twice counts once.
  assert.ok(!got.some((h) => h.title.includes('ankle')))
  assert.ok(!got.some((h) => h.source === 'AP'))
  assert.equal(got[0].at, NOW - 2 * H)
  assert.match(got[0].link, /^https:\/\/x\//)
  // A game story fills in when there is nothing about his status, and entities read as text.
  const plain = parseHeadlines(`<rss>${item('Bucks&apos; Myles Turner scores 20 in win', 'ESPN', 1)}${item('Myles Turner out with ankle sprain', 'ESPN', 73)}</rss>`, 'Myles Turner', NOW)
  assert.deepEqual(plain.map((h) => h.title), ["Bucks' Myles Turner scores 20 in win"])
})

test('headlines: a namesake in other news is left out; his team, basketball or his status place him', () => {
  const xml = `<rss>${item('Toronto man arrested in Calgary (Mark Williams)', 'Reddit', 1)}${item('Suns big Mark Williams sits out shootaround', 'Arizona Republic', 2)}${item('Mark Williams posts 18 and 12', 'NBA.com', 3)}${item('Mark Williams on the Phoenix bench', 'Local', 4)}</rss>`
  assert.deepEqual(parseHeadlines(xml, 'Mark Williams', NOW, 'PHX').map((h) => h.source), ['Arizona Republic', 'Local'])
  // Without his team: only what is plainly basketball, or about whether he plays.
  assert.deepEqual(parseHeadlines(xml, 'Mark Williams', NOW, null).map((h) => h.source), ['Arizona Republic'])
  assert.deepEqual(parseHeadlines(`<rss>${item('Mark Williams scores 18 in Suns loss', 'NBA.com', 1)}</rss>`, 'Mark Williams', NOW, null).map((h) => h.source), ['NBA.com'])
  assert.deepEqual(parseHeadlines(`<rss>${item('Mark Williams joins Ronnie O’Sullivan in British Seniors Open lineup', 'SnookerHQ', 1)}</rss>`, 'Mark Williams', NOW, 'PHX'), [])
})

test('headlines: a suffix or accent in his name still finds him', () => {
  const xml = `<rss>${item('Jaren Jackson: Ruled out Saturday', 'RotoWire', 1)}${item('Luka Doncic (ankle) doubtful', 'CBS Sports', 1)}</rss>`
  assert.equal(parseHeadlines(xml, 'Jaren Jackson Jr.', NOW).length, 1)
  assert.equal(parseHeadlines(xml, 'Luka Dončić', NOW).length, 1)
  assert.match(searchUrl('Luka Dončić'), /%22Luka%20Don%C4%8Di%C4%87%22/)
})

test('headlines are searched every three hours on a game day, every half hour in the two before his tip, not after it', () => {
  const tip = NOW + 5 * H
  assert.equal(headlinesDue(NOW, null, tip), true, 'never searched')
  assert.equal(headlinesDue(NOW, NOW - 2.9 * H, tip), false)
  assert.equal(headlinesDue(NOW, NOW - 3 * H, tip), true)
  const near = tip - 1.5 * H
  assert.equal(headlinesDue(near, near - 29 * 60_000, tip), false)
  assert.equal(headlinesDue(near, near - 30 * 60_000, tip), true)
  assert.equal(headlinesDue(tip + H, tip - 13 * H, tip), false, 'his game is on')
  // No game: twice a day.
  assert.equal(headlinesDue(NOW, NOW - 11 * H, null), false)
  assert.equal(headlinesDue(NOW, NOW - 12 * H, null), true)
})
