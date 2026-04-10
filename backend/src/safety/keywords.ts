/**
 * Layer 1 safety: keyword / regex blocklist.
 *
 * Fast (~microseconds), deterministic, auditable. Catches low-effort violations
 * and obvious CSAM-related phrases before any network call. Never sufficient
 * on its own — combine with OpenAI Moderation + LlamaGuard downstream.
 *
 * Patterns are intentionally broad. False positives are acceptable — the
 * asymmetry of harm for CSAM means a false negative is catastrophic and a
 * false positive is merely an inconvenience.
 */

export interface KeywordMatch {
  category: 'csam' | 'violence' | 'self_harm' | 'illegal_content'
  pattern: string
  matched: string
}

// Age-indicator tokens that, when combined with sexual tokens, are strong
// signals for CSAM-seeking requests.
const AGE_TOKENS = [
  'child',
  'kid',
  'minor',
  'underage',
  'preteen',
  'pre-teen',
  'pre teen',
  'toddler',
  'infant',
  'baby',
  'newborn',
  'prepubescent',
  'pre-pubescent',
  'juvenile',
  'loli',
  'shota',
]

// Explicit sexual tokens. Intentionally conservative.
const SEXUAL_TOKENS = [
  'nude',
  'naked',
  'sex',
  'sexual',
  'porn',
  'erotic',
  'explicit',
  'fondle',
  'molest',
  'grooming',
  'cp',
  'csam',
]

// Combined patterns that are near-always CSAM requests.
const HARD_CSAM_PATTERNS: RegExp[] = [
  /\bcsam\b/i,
  /\bchild\s*porn/i,
  /\bchild\s*p[o0]rn/i,
  /\bcp\s*(pics?|images?|videos?)\b/i,
  /\bpedophil/i,
  /\bloli(con)?\b/i,
  /\bshota(con)?\b/i,
  /\bminor[s]?\s+(nude|naked|sex|sexual|porn)/i,
  /\bunder[\s-]?age[d]?\s+(nude|naked|sex|sexual|porn)/i,
]

// Violence / illegal-content patterns (non-exhaustive — not the focus of this
// proxy's safety layer, which prioritizes CSAM).
const OTHER_PATTERNS: Array<{ re: RegExp; category: KeywordMatch['category'] }> = [
  { re: /\b(how to|instructions for)\s+(build|make|create)\s+a\s+bomb/i, category: 'violence' },
  { re: /\bbioweapon\b/i, category: 'violence' },
  { re: /\bhow to (kill|murder)\s+(myself|yourself)/i, category: 'self_harm' },
]

export function scanKeywords(text: string): KeywordMatch[] {
  const matches: KeywordMatch[] = []
  const normalized = normalize(text)

  // Hard CSAM patterns
  for (const re of HARD_CSAM_PATTERNS) {
    const m = normalized.match(re)
    if (m) matches.push({ category: 'csam', pattern: re.source, matched: m[0] })
  }

  // Co-occurrence: age token AND sexual token within ~80 chars
  const ageHits = findTokens(normalized, AGE_TOKENS)
  const sexualHits = findTokens(normalized, SEXUAL_TOKENS)
  if (ageHits.length > 0 && sexualHits.length > 0) {
    for (const a of ageHits) {
      for (const s of sexualHits) {
        if (Math.abs(a.index - s.index) <= 80) {
          matches.push({
            category: 'csam',
            pattern: 'age+sexual proximity',
            matched: `${a.token}...${s.token}`,
          })
        }
      }
    }
  }

  for (const { re, category } of OTHER_PATTERNS) {
    const m = normalized.match(re)
    if (m) matches.push({ category, pattern: re.source, matched: m[0] })
  }

  return matches
}

function normalize(text: string): string {
  // Collapse common l33tspeak and unicode lookalikes to bare ascii for matching.
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/\$/g, 's')
    .replace(/@/g, 'a')
}

function findTokens(haystack: string, needles: string[]): Array<{ index: number; token: string }> {
  const hits: Array<{ index: number; token: string }> = []
  for (const needle of needles) {
    let from = 0
    while (true) {
      const idx = haystack.indexOf(needle, from)
      if (idx === -1) break
      hits.push({ index: idx, token: needle })
      from = idx + needle.length
    }
  }
  return hits
}
