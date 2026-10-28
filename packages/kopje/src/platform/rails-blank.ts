// Rails' String#blank? (/\A[[:space:]]*\z/, Onigmo's [[:space:]] being White_Space): U+0085 is blank, U+FEFF is not.
export function railsBlank(value: string): boolean {
  return /^\p{White_Space}*$/u.test(value);
}

// Unicode's White_Space code points (PropList.txt): what railsBlank's \p{White_Space} matches.
export const WHITE_SPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
] as const;

// railsBlank over a stored text `value` in SQL: only White_Space characters, or none (trim removes them by character).
export function railsBlankSql(value: string): string {
  return `(trim(${value}, char(${WHITE_SPACE.join(", ")})) = '')`;
}
