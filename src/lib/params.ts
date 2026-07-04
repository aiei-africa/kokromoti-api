// Express 5's types allow route params and query values to be
// string | string[] (to support repeated/array-style query params and
// wildcard routes). Prisma's `where` clauses expect a plain string.
// This coerces safely: arrays take their first element, everything else
// passes through as a string, undefined/missing stays undefined.
export function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value[0] !== undefined ? String(value[0]) : undefined;
  return String(value);
}

// Same, but throws if missing — for required route params like :code.
export function requireString(value: unknown, label: string): string {
  const s = asString(value);
  if (!s) throw new Error(`${label} is required`);
  return s;
}
