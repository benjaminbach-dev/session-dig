// Correctifs partagés de temps (relecture M3b2) : epoch 0 est une date valide, et
// les années 0–99 sont préservées (Date.UTC les mapperait sur 1900–1999).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtTs, parseDateBound, utcFromParts } from '../src/util.js'
import { parseAnchorTimestamp, resolveAnchor } from '../src/read.js'

test('fmtTs : epoch 0 est une date valide, jamais « ? »', () => {
  assert.equal(fmtTs(0), '1970-01-01 00:00')
  assert.equal(fmtTs(null), '?')
  assert.equal(fmtTs(undefined), '?')
  assert.equal(fmtTs(NaN), '?')
  assert.equal(fmtTs(Number.POSITIVE_INFINITY), '?')
})

test('années 0–99 préservées par le parseur d’ancre (UTC strict)', () => {
  const a = parseAnchorTimestamp('0099-01-01')
  assert.equal(new Date(a.ts).getUTCFullYear(), 99)
  assert.equal(fmtTs(a.ts), '0099-01-01 23:59') // date seule = fin de journée
  const b = parseAnchorTimestamp('0099-06-15T10:30')
  assert.equal(new Date(b.ts).getUTCFullYear(), 99)
  assert.equal(fmtTs(b.ts), '0099-06-15 10:30')
  assert.notEqual(utcFromParts(99, 0, 1), Date.UTC(99, 0, 1), 'pas de report silencieux sur 1999')
  assert.equal(new Date(utcFromParts(99, 0, 1)).getUTCFullYear(), 99)
})

test('calendrier strict exact pour les années faibles (bissextiles proleptiques)', () => {
  assert.equal(parseAnchorTimestamp('0000-02-29').error, undefined, 'année 0 bissextile')
  assert.match(parseAnchorTimestamp('0100-02-29').error, /jour hors bornes/, '100 non bissextile')
  assert.equal(parseAnchorTimestamp('0400-02-29').error, undefined, '400 bissextile')
})

test('epoch 0 : ancre horodatée valide et lisible', () => {
  const a = resolveAnchor([], '0000000000000')
  assert.deepEqual(a, { ts: 0, id: null })
  assert.equal(fmtTs(a.ts), '1970-01-01 00:00')
})

test('parseDateBound préserve aussi les années 0–99', () => {
  assert.equal(new Date(parseDateBound('0099-01-01')).getUTCFullYear(), 99)
  assert.equal(new Date(parseDateBound('0099-12', true)).getUTCFullYear(), 99)
})

test('utcFromParts : normalisation DANS l’année cible (jour 0, mois 12, années 0–99)', () => {
  // Jour 0 du mois 0 de 2027 = 31/12/2026 (jamais 31/12/2027).
  assert.equal(utcFromParts(2027, 0, 0, 23, 59, 59, 999), Date.UTC(2026, 11, 31, 23, 59, 59, 999))
  // Jour 0 du mois 2 (mars) : 28/02 pour une année NON bissextile, 29/02 pour une bissextile.
  assert.equal(utcFromParts(2026, 2, 0), Date.UTC(2026, 2, 0))
  assert.equal(new Date(utcFromParts(2026, 2, 0)).getUTCMonth(), 1)
  assert.equal(new Date(utcFromParts(2026, 2, 0)).getUTCDate(), 28)
  assert.equal(utcFromParts(2028, 2, 0), Date.UTC(2028, 2, 0))
  assert.equal(new Date(utcFromParts(2028, 2, 0)).getUTCDate(), 29)
  // Années 0–99 préservées, y compris jour 0 / mois 12.
  assert.equal(new Date(utcFromParts(0, 0, 1)).getUTCFullYear(), 0)
  assert.equal(new Date(utcFromParts(99, 11, 31)).getUTCFullYear(), 99)
  // Concordance avec `Date.UTC` pour les années >= 100.
  for (const [y, mo, d] of [[2026, 0, 1], [2026, 2, 0], [2027, 0, 0], [1900, 2, 0], [2000, 2, 0], [2028, 1, 29]]) {
    assert.equal(utcFromParts(y, mo, d), Date.UTC(y, mo, d), `${y}-${mo}-${d}`)
  }
})

test('parseDateBound end : fin d’année/mois EXACTE (bissextile, siècle, 0099/0000)', () => {
  assert.equal(parseDateBound('2026', true), Date.UTC(2026, 11, 31, 23, 59, 59, 999))
  assert.equal(parseDateBound('2026-02', true), Date.UTC(2026, 2, 0, 23, 59, 59, 999), 'février non bissextile ⇒ 28/02')
  assert.equal(parseDateBound('2028-02', true), Date.UTC(2028, 2, 0, 23, 59, 59, 999), 'février bissextile ⇒ 29/02')
  assert.equal(parseDateBound('1900-02', true), Date.UTC(1900, 2, 0, 23, 59, 59, 999), 'siècle non bissextile')
  assert.equal(parseDateBound('2000-02', true), Date.UTC(2000, 2, 0, 23, 59, 59, 999), 'siècle bissextile')
  assert.equal(new Date(parseDateBound('0099', true)).getUTCFullYear(), 99)
  assert.equal(new Date(parseDateBound('0000', true)).getUTCFullYear(), 0)
  assert.equal(new Date(parseDateBound('0000-02', true)).getUTCDate(), 29, 'an 0 bissextile')
})
