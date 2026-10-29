// A time in ms since the epoch as Date#toISOString writes it.
export function iso(now: number): string {
  return new Date(now).toISOString();
}
