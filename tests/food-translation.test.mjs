import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/food-translation.ts', import.meta.url), 'utf8')
const javascript = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(javascript).toString('base64')
const { applyFoodGlossary, translateMenuText } = await import(moduleUrl)

test('Kannada distinguishes boiled rice from parboiled rice', async () => {
  assert.equal(applyFoodGlossary('boiled rice', 'kn'), 'ಬೇಯಿಸಿದ ಅನ್ನ')
  assert.equal(applyFoodGlossary('parboiled rice', 'kn'), 'ಕುಚ್ಚಲಕ್ಕಿ')
  assert.equal(await translateMenuText('boiled rice', 'kn'), 'ಬೇಯಿಸಿದ ಅನ್ನ')
  assert.equal(await translateMenuText('parboiled rice', 'kn'), 'ಕುಚ್ಚಲಕ್ಕಿ')
})

test('food and portion glossary terms are protected in all supported languages', () => {
  const expected = {
    hi: ['मसाला डोसा', 'इडली वड़ा', 'आधी प्लेट', 'पूरी प्लेट'],
    kn: ['ಮಸಾಲೆ ದೋಸೆ', 'ಇಡ್ಲಿ ವಡೆ', 'ಅರ್ಧ ಪ್ಲೇಟ್', 'ಪೂರ್ಣ ಪ್ಲೇಟ್'],
    ta: ['மசாலா தோசை', 'இட்லி வடை', 'அரை பிளேட்', 'முழு பிளேட்'],
    te: ['మసాలా దోశ', 'ఇడ్లీ వడ', 'హాఫ్ ప్లేట్', 'ఫుల్ ప్లేట్'],
    ml: ['മസാല ദോശ', 'ഇഡ്ഡലി വട', 'ഹാഫ് പ്ലേറ്റ്', 'ഫുൾ പ്ലേറ്റ്'],
  }
  for (const [language, values] of Object.entries(expected)) {
    const result = applyFoodGlossary('Masala Dosa, Idli Vada — Half Plate / Full Plate', language)
    for (const value of values) assert.ok(result.includes(value), language + ' should contain ' + value)
  }
})

test('food glossary matching is case-insensitive and preserves surrounding description text', () => {
  assert.equal(applyFoodGlossary('Served with BOILED RICE.', 'kn'), 'Served with ಬೇಯಿಸಿದ ಅನ್ನ.')
  assert.equal(applyFoodGlossary('PARBOILED RICE, masala dosa', 'kn'), 'ಕುಚ್ಚಲಕ್ಕಿ, ಮಸಾಲೆ ದೋಸೆ')
})
