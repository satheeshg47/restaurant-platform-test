export type MenuLanguage = 'hi' | 'kn' | 'ta' | 'te' | 'ml'

const FOOD_GLOSSARY: Record<MenuLanguage, Record<string, string>> = {
  hi: {
    'boiled rice': 'उबले हुए चावल', 'masala dosa': 'मसाला डोसा', 'idli vada': 'इडली वड़ा',
    'half plate': 'आधी प्लेट', 'full plate': 'पूरी प्लेट', 'plain dosa': 'सादा डोसा',
    'curd rice': 'दही चावल', 'lemon rice': 'नींबू चावल', 'sambar': 'सांभर', 'rasam': 'रसम',
  },
  kn: {
    'boiled rice': 'ಕುಚ್ಚಲಕ್ಕಿ', 'masala dosa': 'ಮಸಾಲೆ ದೋಸೆ', 'idli vada': 'ಇಡ್ಲಿ ವಡೆ',
    'half plate': 'ಅರ್ಧ ಪ್ಲೇಟ್', 'full plate': 'ಪೂರ್ಣ ಪ್ಲೇಟ್', 'plain dosa': 'ಸಾದಾ ದೋಸೆ',
    'curd rice': 'ಮೊಸರನ್ನ', 'lemon rice': 'ನಿಂಬೆ ಚಿತ್ರಾನ್ನ', 'sambar': 'ಸಾಂಬಾರ್', 'rasam': 'ರಸಂ',
  },
  ta: {
    'boiled rice': 'புழுங்கல் அரிசி', 'masala dosa': 'மசாலா தோசை', 'idli vada': 'இட்லி வடை',
    'half plate': 'அரை பிளேட்', 'full plate': 'முழு பிளேட்', 'plain dosa': 'சாதா தோசை',
    'curd rice': 'தயிர் சாதம்', 'lemon rice': 'எலுமிச்சை சாதம்', 'sambar': 'சாம்பார்', 'rasam': 'ரசம்',
  },
  te: {
    'boiled rice': 'ఉప్పుడు బియ్యం', 'masala dosa': 'మసాలా దోశ', 'idli vada': 'ఇడ్లీ వడ',
    'half plate': 'హాఫ్ ప్లేట్', 'full plate': 'ఫుల్ ప్లేట్', 'plain dosa': 'సాదా దోశ',
    'curd rice': 'పెరుగు అన్నం', 'lemon rice': 'నిమ్మకాయ అన్నం', 'sambar': 'సాంబార్', 'rasam': 'రసం',
  },
  ml: {
    'boiled rice': 'പുഴുങ്ങിയ അരി', 'masala dosa': 'മസാല ദോശ', 'idli vada': 'ഇഡ്ഡലി വട',
    'half plate': 'ഹാഫ് പ്ലേറ്റ്', 'full plate': 'ഫുൾ പ്ലേറ്റ്', 'plain dosa': 'പ്ലെയിൻ ദോശ',
    'curd rice': 'തൈര് ചോറ്', 'lemon rice': 'നാരങ്ങ ചോറ്', 'sambar': 'സാമ്പാർ', 'rasam': 'രസം',
  },
}

export function applyFoodGlossary(source: string, language: MenuLanguage) {
  let output = source
  const glossary = FOOD_GLOSSARY[language]
  for (const [english, translated] of Object.entries(glossary).sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp('(^|[^\\p{L}\\p{N}])' + english + '(?=$|[^\\p{L}\\p{N}])', 'giu'), (_match, prefix: string) => prefix + translated)
  }
  return output
}

export async function translateMenuText(source: string, language: MenuLanguage) {
  const glossary = FOOD_GLOSSARY[language]
  const protectedTerms: string[] = []
  let prepared = source
  for (const [english, translated] of Object.entries(glossary).sort((a, b) => b[0].length - a[0].length)) {
    const expression = new RegExp('(^|[^\\p{L}\\p{N}])' + english + '(?=$|[^\\p{L}\\p{N}])', 'giu')
    prepared = prepared.replace(expression, (_match, prefix: string) => {
      const token = 'ZXQFOODTERM' + protectedTerms.length + 'XZ'
      protectedTerms.push(translated)
      return prefix + token
    })
  }
  if (!prepared.trim()) return ''
  let translated = prepared
  const glossaryOnly = protectedTerms.length > 0 && prepared.replace(/ZXQFOODTERM\\d+XZ/g, '').trim() === ''
  if (glossaryOnly) {
    translated = prepared
  } else if (prepared !== source) {
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({ client: 'gtx', sl: 'en', tl: language, dt: 't', q: prepared }).toString()
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (response.ok) {
        const payload = await response.json()
        const value = Array.isArray(payload?.[0]) ? payload[0].map((part: unknown[]) => String(part?.[0] || '')).join('').trim() : ''
        if (value) translated = value
      }
    } catch { /* glossary-only translation remains available offline */ }
  } else {
    const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({ client: 'gtx', sl: 'en', tl: language, dt: 't', q: source }).toString()
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('Translation service is temporarily unavailable. You can type the translation manually.')
    const payload = await response.json()
    translated = Array.isArray(payload?.[0]) ? payload[0].map((part: unknown[]) => String(part?.[0] || '')).join('').trim() : ''
    if (!translated) throw new Error('No translation was returned. Please enter the translation manually.')
  }
  protectedTerms.forEach((value, index) => { translated = translated.split('ZXQFOODTERM' + index + 'XZ').join(value) })
  return applyFoodGlossary(translated, language)
}
