const terminal = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);

// Sparse transport events and complete durable reads share one monotonic job.
export function mergePublicJob(current, incoming, { durable = false } = {}) {
  if (!incoming?.jobId) return current;
  if (!current) return incoming;
  if (incoming.jobId !== current.jobId) return current;
  const priorSequence = Number.isSafeInteger(current.sequence) ? current.sequence : 0;
  const nextSequence = Number.isSafeInteger(incoming.sequence) ? incoming.sequence : 0;
  if (nextSequence < priorSequence || (terminal.has(current.phase) && incoming.phase && !terminal.has(incoming.phase))) return current;
  const equal = nextSequence === priorSequence;
  const result = { ...current, ...incoming };
  if (equal && !durable) {
    for (const [key, value] of Object.entries(current)) if (value !== null && value !== undefined) result[key] = value;
  }
  result.cancellationRequested = current.cancellationRequested === true || incoming.cancellationRequested === true;
  result.outcome = incoming.outcome ?? current.outcome ?? null;
  result.progress = equal && !durable ? current.progress ?? incoming.progress : incoming.progress ?? current.progress;
  const events = new Map();
  for (const event of [...(current.events || []), ...(incoming.events || [])]) {
    events.set(`${event.sequence}:${event.channel}:${event.timestamp}:${event.message}`, event);
  }
  result.events = [...events.values()].sort((left, right) => left.sequence - right.sequence).slice(-500);
  return result;
}
