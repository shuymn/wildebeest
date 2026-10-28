// The one rule by which an Access identity's email names a stored email (AUTH-9): equal after SQLite's lower(), which,
// built without ICU, folds ASCII A-Z only, with no trim. A Unicode case variant (U+212A, U+1E9E, U+0130) is another
// email. Every stage that matches an email uses it: in SQL loginEmailMatchSql, in code sameLoginEmail.

export function loginEmailMatchSql(column: string): string {
  return `lower(${column}) = lower(?)`;
}

// A lone surrogate, which SQLite stores as U+FFFD, keeps its identity here, so this may tell apart two values SQL
// equates but never equates two that SQL tells apart.
export function sameLoginEmail(a: string, b: string): boolean {
  return sqliteLower(a) === sqliteLower(b);
}

// SQLite's lower() without ICU: ASCII A-Z to a-z, every other code unit unchanged.
export function sqliteLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}
