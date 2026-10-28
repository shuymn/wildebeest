// A Queue's backlog, read through the binding's metrics for checks that need the Queue empty. Queues leaves a
// delayed message (sent or retried with delaySeconds) out of backlogCount while its bytes stay in backlogBytes, so the
// Queue counts as empty only when both are 0. Fails closed: null when the binding has no metrics, the read fails, or
// a field is not a finite non-negative number.
export type QueueBacklog = { count: number; empty: boolean };

export async function readQueueBacklog(queue: Queue | undefined): Promise<QueueBacklog | null> {
  const metrics = (queue as Partial<Pick<Queue, "metrics">> | undefined)?.metrics;
  if (queue === undefined || typeof metrics !== "function") {
    return null;
  }
  try {
    const { backlogCount, backlogBytes } = await metrics.call(queue);
    if (!isSize(backlogCount) || !isSize(backlogBytes)) {
      return null;
    }
    return { count: backlogCount, empty: backlogCount === 0 && backlogBytes === 0 };
  } catch {
    return null;
  }
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
