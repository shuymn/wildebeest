// A deadline for awaited work (the cutover drain, the media rebuild): past it nothing new is started, and what is
// running is given up. What is given up may still land, so a caller that gives up keeps its lease until it expires.

export class DeadlinePassed extends Error {}

// Runs work, given up once the clock reaches `end` (or not started at all past it).
export async function within<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
  const left = end - now();
  if (left <= 0) {
    throw new DeadlinePassed();
  }
  const running = work();
  running.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlinePassed()), left);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// `within`, whose result arriving at or past `end` is not used either: a Store call of a cron round (federation/
// field-links.ts, federation/link-cards.ts) that lands late is treated as given up.
export async function inTime<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
  const result = await within(work, end, now);
  if (now() >= end) {
    throw new DeadlinePassed();
  }
  return result;
}

// `within`, a call given up kept in `running` until it settles: a cron round whose given-up call still holds memory
// starts nothing more while one runs (federation/card-images.ts, federation/remote-media.ts, each its own set).
export async function withinKept<T>(
  running: Set<Promise<unknown>>,
  work: () => Promise<T>,
  end: number,
  now: () => number,
): Promise<T> {
  let call: Promise<T> | undefined;
  try {
    return await within(
      () => {
        call = work();
        return call;
      },
      end,
      now,
    );
  } catch (error) {
    if (error instanceof DeadlinePassed && call !== undefined) {
      // Added here and removed in a later microtask, once it settles (at once if it already has).
      const given: Promise<T> = call;
      running.add(given);
      given.then(
        () => running.delete(given),
        () => running.delete(given),
      );
    }
    throw error;
  }
}
