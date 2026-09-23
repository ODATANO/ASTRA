/**
 * OData query options for entities a handler computes itself.
 *
 * CAP hands a `@cds.persistence.skip` entity to its on-handler and returns whatever comes back,
 * so `$filter`, `$orderby`, `$top`/`$skip`, `$select` and `$count` are the handler's job. This
 * module does that job once for every computed entity: it turns the CQN `where` into a
 * predicate, sorts, slices and projects.
 *
 * It also reads the *constraints* out of the filter before anything is computed — the
 * `chain eq 'cardano'`, `window eq '7d'` and `day ge 2026-09-01` parts — so a handler can
 * compute only the rows that can survive the filter instead of everything and then throwing
 * most of it away. Only conjunctions at the top level count as constraints; anything under an
 * `or` is applied afterwards by the predicate, never used to narrow.
 *
 * Supported filter: `eq ne gt ge lt le` between a column and a literal, `is null` / `is not
 * null`, `and`, `or`, `not`, parentheses. Anything else (functions such as `contains`, arithmetic,
 * column-to-column) is refused with 400 rather than silently ignored.
 */

export type Op = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=';

export interface Constraints {
  /** column -> accepted values from top-level `col eq v` (several when `col eq a and col eq b`, which is empty in practice) */
  eq: Map<string, unknown[]>;
  /** column -> inclusive/exclusive bounds from top-level range comparisons */
  ranges: Map<string, { op: Op; value: unknown }[]>;
}

export interface ParsedQuery {
  where: any[] | undefined;
  constraints: Constraints;
  test: (row: Record<string, unknown>) => boolean;
  orderBy: { column: string; desc: boolean }[];
  top: number | null;
  skip: number;
  count: boolean;
  columns: string[] | null;
}

class FilterError extends Error {
  constructor(message: string) { super(message); this.name = 'FilterError'; }
}

const ISO = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/;

/** Ordering that treats numbers as numbers, ISO dates as instants and everything else as text. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a)) && !ISO.test(a) ? Number(a) : null;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b)) && !ISO.test(b) ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  const sa = String(a), sb = String(b);
  if (ISO.test(sa) && ISO.test(sb)) {
    // a Date compared with a Timestamp: put both on the same scale
    const da = Date.parse(sa.length === 10 ? sa + 'T00:00:00Z' : sa);
    const db = Date.parse(sb.length === 10 ? sb + 'T00:00:00Z' : sb);
    if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function holds(op: Op, left: unknown, right: unknown): boolean {
  if (op === '=' ) return left === null || left === undefined ? right === null : compareValues(left, right) === 0;
  if (op === '!=' || op === '<>') return !holds('=', left, right);
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const c = compareValues(left, right);
  return op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0;
}

const isOp = (t: unknown): t is Op => typeof t === 'string' && ['=', '!=', '<>', '>', '>=', '<', '<='].includes(t);
const colOf = (t: any): string | null => (t && Array.isArray(t.ref) && t.ref.length === 1 && typeof t.ref[0] === 'string' ? t.ref[0] : null);
const isVal = (t: any): boolean => t && typeof t === 'object' && 'val' in t;
const lower = (t: unknown) => (typeof t === 'string' ? t.toLowerCase() : t);

/** Split a flat token list at a keyword that sits at depth 0 (parentheses arrive as `{xpr}` already). */
function splitAt(tokens: any[], keyword: string): any[][] {
  const out: any[][] = [];
  let cur: any[] = [];
  for (const t of tokens) {
    if (lower(t) === keyword) { out.push(cur); cur = []; } else cur.push(t);
  }
  out.push(cur);
  return out;
}

type Pred = (row: Record<string, unknown>) => boolean;

function compileAtom(tokens: any[], constraints: Constraints | null): Pred {
  if (tokens.length === 1 && tokens[0] && Array.isArray(tokens[0].xpr)) return compile(tokens[0].xpr, null);
  if (tokens.length >= 2 && lower(tokens[0]) === 'not') {
    const inner = compileAtom(tokens.slice(1), null);
    return row => !inner(row);
  }
  // col is null / col is not null
  if (tokens.length >= 3 && colOf(tokens[0]) && lower(tokens[1]) === 'is') {
    const col = colOf(tokens[0])!;
    const negated = lower(tokens[2]) === 'not';
    return row => (row[col] === null || row[col] === undefined) !== negated;
  }
  if (tokens.length === 3 && isOp(tokens[1])) {
    const op = tokens[1];
    if (colOf(tokens[0]) && isVal(tokens[2])) {
      const col = colOf(tokens[0])!, value = tokens[2].val;
      if (constraints) {
        if (op === '=') constraints.eq.set(col, [...(constraints.eq.get(col) ?? []), value]);
        else if (op !== '!=' && op !== '<>') constraints.ranges.set(col, [...(constraints.ranges.get(col) ?? []), { op, value }]);
      }
      return row => holds(op, row[col], value);
    }
    if (isVal(tokens[0]) && colOf(tokens[2])) {
      // literal on the left: flip the operator
      const col = colOf(tokens[2])!, value = tokens[0].val;
      const flipped: Op = op === '>' ? '<' : op === '>=' ? '<=' : op === '<' ? '>' : op === '<=' ? '>=' : op;
      return compileAtom([{ ref: [col] }, flipped, { val: value }], constraints);
    }
  }
  throw new FilterError('unsupported $filter: use column eq/ne/gt/ge/lt/le literal, is null, and/or/not, parentheses');
}

function compile(tokens: any[], constraints: Constraints | null): Pred {
  if (!tokens || tokens.length === 0) return () => true;
  const ors = splitAt(tokens, 'or');
  if (ors.length > 1) {
    const parts = ors.map(p => compile(p, null)); // nothing under an `or` may narrow
    return row => parts.some(p => p(row));
  }
  const ands = splitAt(tokens, 'and');
  const parts = ands.map(p => compileAtom(p, constraints));
  return row => parts.every(p => p(row));
}

/**
 * Reads the query options of a READ request: the filter (from `$filter` and from a key in the
 * URL, which CAP puts on the `from` ref), ordering, paging, count and projection.
 */
export function parseQuery(req: any): ParsedQuery {
  const select = req.query?.SELECT ?? {};
  const fromRef = select.from?.ref?.[0];
  const keyWhere: any[] | undefined = fromRef && typeof fromRef === 'object' ? fromRef.where : undefined;
  const where: any[] | undefined = select.where && keyWhere ? [{ xpr: keyWhere }, 'and', { xpr: select.where }] : (select.where ?? keyWhere);
  const constraints: Constraints = { eq: new Map(), ranges: new Map() };
  let test: Pred;
  try {
    // a key access is a conjunction too: let it narrow
    test = where === keyWhere && keyWhere ? compile(keyWhere, constraints) : compile(where ?? [], constraints);
    if (where !== keyWhere && keyWhere) compile(keyWhere, constraints);
  } catch (err) {
    if (err instanceof FilterError) return req.reject(400, err.message);
    throw err;
  }
  // CAP appends the keys as implicit order when a page limit applies; that is not the caller's wish
  const orderBy = Array.isArray(select.orderBy)
    ? select.orderBy.filter((o: any) => !o.implicit).map((o: any) => ({ column: colOf(o) ?? String(o.ref?.join('.')), desc: String(o.sort ?? 'asc').toLowerCase() === 'desc' }))
    : [];
  const limit = select.limit ?? {};
  const top = limit.rows?.val !== undefined ? Number(limit.rows.val) : null;
  const skip = limit.offset?.val !== undefined ? Number(limit.offset.val) : 0;
  const columns = Array.isArray(select.columns) && select.columns.length && select.columns.every((c: any) => colOf(c))
    ? select.columns.map((c: any) => colOf(c)!)
    : null;
  return { where, constraints, test, orderBy, top, skip, count: select.count === true, columns };
}

/** Values a column is pinned to by the filter, or null when it is free. */
export function pinned<T = string>(q: ParsedQuery, column: string): T[] | null {
  const v = q.constraints.eq.get(column);
  return v && v.length ? (v as T[]) : null;
}

/** Lower and upper bound of a column from the filter (ISO strings or numbers as given), when any. */
export function bounds(q: ParsedQuery, column: string): { min?: unknown; max?: unknown; minExclusive?: boolean; maxExclusive?: boolean } {
  const out: { min?: unknown; max?: unknown; minExclusive?: boolean; maxExclusive?: boolean } = {};
  for (const r of q.constraints.ranges.get(column) ?? []) {
    if (r.op === '>' || r.op === '>=') { if (out.min === undefined || compareValues(r.value, out.min) > 0) { out.min = r.value; out.minExclusive = r.op === '>'; } }
    if (r.op === '<' || r.op === '<=') { if (out.max === undefined || compareValues(r.value, out.max) < 0) { out.max = r.value; out.maxExclusive = r.op === '<'; } }
  }
  return out;
}

/**
 * Applies filter, order, paging and projection to computed rows. `defaultOrder` is used when the
 * request names none, so a plain GET reads sensibly (newest first, rank ascending, ...).
 */
export function applyQuery<T extends Record<string, unknown>>(rows: T[], q: ParsedQuery, defaultOrder: { column: string; desc?: boolean }[] = []): T[] & { $count?: number } {
  let out = rows.filter(q.test);
  const order = q.orderBy.length ? q.orderBy : defaultOrder.map(o => ({ column: o.column, desc: !!o.desc }));
  if (order.length) {
    out = [...out].sort((a, b) => {
      for (const o of order) {
        const c = compareValues(a[o.column], b[o.column]);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  const total = out.length;
  if (q.skip) out = out.slice(q.skip);
  if (q.top !== null && q.top >= 0) out = out.slice(0, q.top);
  if (q.columns) out = out.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => q.columns!.includes(k))) as T);
  const result = out as T[] & { $count?: number };
  if (q.count) result.$count = total;
  return result;
}
