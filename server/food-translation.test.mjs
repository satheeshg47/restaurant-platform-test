import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFoodGlossary } from '../src/food-translation.ts'

test('Kannada distinguishes cooked boiled rice from parboiled rice', () => {
  assert.equal(applyFoodGlossary('Boiled Rice', 'kn'), 'ಬೇಯಿಸಿದ ಅನ್ನ')
  assert.equal(applyFoodGlossary('Parboiled Rice', 'kn'), 'ಕುಚ್ಚಲಕ್ಕಿ')
})

test('food glossary covers common dishes and portions in all configured languages', () => {
  for (const language of ['hi', 'kn', 'ta', 'te', 'ml']) {
    assert.notEqual(applyFoodGlossary('Masala Dosa', language), 'Masala Dosa')
    assert.notEqual(applyFoodGlossary('Idli Vada', language), 'Idli Vada')
    assert.notEqual(applyFoodGlossary('Half Plate', language), 'Half Plate')
    assert.notEqual(applyFoodGlossary('Full Plate', language), 'Full Plate')
  }
})
