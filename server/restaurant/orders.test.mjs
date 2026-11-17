import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateTaxMinor } from './orders.mjs'

test('calculates exclusive tax using integer minor units', () => {
  assert.deepEqual(calculateTaxMinor(10000n, 'single', 5, false), {
    tax: 500n,
    total: 10500n,
  })
})

test('extracts inclusive tax without increasing the displayed total', () => {
  assert.deepEqual(calculateTaxMinor(10500n, 'gst', 5, true), {
    tax: 500n,
    total: 10500n,
  })
})

test('returns zero tax when tax is disabled', () => {
  assert.deepEqual(calculateTaxMinor(12345n, 'none', 18, false), {
    tax: 0n,
    total: 12345n,
  })
})

test('rounds fractional tax rates to the nearest paise', () => {
  assert.deepEqual(calculateTaxMinor(10000n, 'single', 5.5, false), {
    tax: 550n,
    total: 10550n,
  })
})
