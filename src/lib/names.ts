// ─── R13: person-name hygiene ────────────────────────────────────────
// Shared by the API (deferred checks, reservations, customers) and the
// POS UI so client-entered names land in the DB consistently:
// trimmed, inner whitespace collapsed, and title-cased per word.

/**
 * Normalize a person/client name: collapse whitespace and title-case each
 * word ("  ahmed   mohamed " → "Ahmed Mohamed"). Pure function — safe on
 * client and server. Words that are already ALL-CAPS (2+ letters) keep
 * their shape ("IBM Partner" stays recognizable) — only mixed/lowercase
 * words are re-cased.
 */
export function normalizePersonName(raw: string | null | undefined): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed
    .split(' ')
    .map((word) => {
      // preserve acronyms / ALL-CAPS words (≥ 2 letters)
      if (word.length >= 2 && word === word.toUpperCase()) return word
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}
