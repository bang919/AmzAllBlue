function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
}

function logLine(prefix, fields) {
  console.log(`${prefix}\t${formatFields(fields)}`);
}

export function logApiRequest({ method, path, status, durationMs }) {
  logLine("[api]", { time: new Date().toISOString(), method, path, status, ms: durationMs });
}

export function logAmazonRequest({ method, path, status, durationMs, attempt, context, error }) {
  logLine("[amazon]", { time: new Date().toISOString(), method, path, status, ms: durationMs, attempt, context, error });
}

export function logFbaSync({ time, status, reason, startDate, endDate, days, warnings, error, detail }) {
  logLine("[fba-sync]", {
    time: time || new Date().toISOString(),
    status,
    reason,
    start: startDate,
    end: endDate,
    days,
    warnings,
    error,
    detail,
  });
}
