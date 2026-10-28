// The order Array.prototype.sort gives without a compare function, by String(value) in UTF-16 code units, for arrays
// of values that are not all strings (tuples, nullable ids).
export function byText(a: unknown, b: unknown): number {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
