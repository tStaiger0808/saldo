/**
 * A restored dump is untrusted, even with the right passphrase: a superuser may upload a foreign archive. Only what
 * Saldo's own pg_dump produces is restored (tables, their data, sequences, defaults, indexes and constraints in the
 * `public` and `drizzle` schemas), and afterwards the new database is checked for anything that could run code later
 * as the app's database user (functions, triggers, rules, views, foreign extensions, …) and compared with a database
 * built from Saldo's own migrations, so no default, check, generated column or index can carry an expression of its
 * own, before it is swapped in.
 */
import type postgres from "postgres";
import { msg } from "../../../i18n/index.ts";
import { UserError } from "../../errors.ts";

const SCHEMAS = new Set(["public", "drizzle"]);

/** Entry types restored from a dump; longer names first, so "TABLE DATA" is not read as "TABLE". */
const RESTORED_TYPES = [
  "SEQUENCE OWNED BY",
  "SEQUENCE SET",
  "FK CONSTRAINT",
  "TABLE DATA",
  "CONSTRAINT",
  "SEQUENCE",
  "DEFAULT",
  "INDEX",
  "TABLE",
] as const;

/**
 * Entries our pg_dump writes that are left out on purpose: the `public` schema comes with the new database, unaccent is
 * created by Saldo itself (migrations), and comments and privileges are never restored.
 */
const SKIPPED = [
  /^SCHEMA - public( |$)/,
  /^COMMENT - SCHEMA public( |$)/,
  /^ACL - SCHEMA public( |$)/,
  /^EXTENSION - unaccent( |$)/,
  /^COMMENT - EXTENSION unaccent( |$)/,
];

const refuse = (entry: string) => new UserError(msg("backup.errors.unsafeDump", { entry: entry.slice(0, 120) }));

/**
 * Checks the output of `pg_restore --list` and returns the list to restore with `-L`: only allowed entries, in their
 * original order. Any other entry refuses the whole dump.
 */
export function restorableList(list: string): string {
  const keep: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith(";")) continue;
    const entry = line.match(/^(\d+); \d+ \d+ (.*)$/);
    if (!entry) throw refuse(line);
    const rest = entry[2] as string;
    if (SKIPPED.some((pattern) => pattern.test(rest))) continue;
    if (/^SCHEMA - drizzle( |$)/.test(rest)) {
      keep.push(line);
      continue;
    }
    const type = RESTORED_TYPES.find((candidate) => rest.startsWith(`${candidate} `));
    const schema = type ? rest.slice(type.length + 1).split(" ")[0] : undefined;
    if (!type || !schema || !SCHEMAS.has(schema)) throw refuse(rest);
    keep.push(line);
  }
  if (keep.length === 0) throw refuse("-");
  return `${keep.join("\n")}\n`;
}

/** Query and the kind of object it finds; each must find nothing in a database restored from a Saldo dump. */
const FORBIDDEN: [string, string][] = [
  [
    "FUNCTION",
    `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`,
  ],
  ["EXTENSION", `select extname as name from pg_extension where extname not in ('plpgsql', 'unaccent')`],
  ["TRIGGER", `select tgname as name from pg_trigger where not tgisinternal`],
  ["EVENT TRIGGER", `select evtname as name from pg_event_trigger`],
  [
    "RULE",
    `select r.rulename as name from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace
     where n.nspname not in ('pg_catalog', 'information_schema')`,
  ],
  ["POLICY", `select polname as name from pg_policy`],
  [
    "SCHEMA",
    `select nspname as name from pg_namespace
     where nspname not in ('public', 'drizzle', 'pg_catalog', 'information_schema', 'pg_toast')
       and nspname not like 'pg\\_temp\\_%' and nspname not like 'pg\\_toast\\_temp\\_%'`,
  ],
  [
    "RELATION",
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'drizzle') and (c.relkind not in ('r', 'S', 'i') or c.relacl is not null)`,
  ],
  [
    "TYPE",
    `select t.typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname in ('public', 'drizzle') and t.typrelid = 0 and t.typelem = 0
       and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')`,
  ],
  [
    "OPERATOR",
    `select o.oprname as name from pg_operator o join pg_namespace n on n.oid = o.oprnamespace
     where n.nspname not in ('pg_catalog', 'information_schema')`,
  ],
  ["LARGE OBJECT", `select oid::text as name from pg_largeobject_metadata`],
  ["PUBLICATION", `select pubname as name from pg_publication`],
  ["FOREIGN SERVER", `select srvname as name from pg_foreign_server`],
  ["DEFAULT ACL", `select defaclrole::regrole::text as name from pg_default_acl`],
  [
    "SETTING",
    `select 'database' as name from pg_db_role_setting where setdatabase = (select oid from pg_database where datname = current_database())`,
  ],
];

/** Refuses a restored database that holds anything a Saldo dump never contains. */
export async function auditRestored(sql: postgres.Sql): Promise<void> {
  for (const [kind, query] of FORBIDDEN) {
    const [found] = await sql.unsafe<{ name: string }[]>(`${query} limit 1`);
    if (found) throw refuse(`${kind} ${found.name}`);
  }
}

/**
 * Every relation, column (type, nullability, identity, generated expression, default, collation), constraint, index,
 * sequence and statistics object in `public` and `drizzle`, keyed by kind and name. Positions and OIDs are left out:
 * a restore recreates tables without dropped columns and with new OIDs.
 */
const SCHEMA_OBJECTS = `
  with rel as (
    select c.oid, c.relkind, c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'drizzle')
  )
  select 'RELATION ' || r.name as key,
    json_build_array(c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.reloftype::regtype::text, c.reloptions,
      (select array_agg(i.inhparent::regclass::text order by i.inhseqno) from pg_inherits i where i.inhrelid = c.oid))::text as definition
  from rel r join pg_class c on c.oid = r.oid
  union all
  select 'INDEX ' || r.name, pg_get_indexdef(r.oid) from rel r where r.relkind in ('i', 'I')
  union all
  select 'SEQUENCE ' || r.name,
    json_build_array(s.seqtypid::regtype::text, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
      (select array_agg(d.deptype::text || ' ' || d.refobjid::regclass::text || '.' || quote_ident(a.attname))
       from pg_depend d join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
       where d.classid = 'pg_class'::regclass and d.objid = r.oid and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))::text
  from rel r join pg_sequence s on s.seqrelid = r.oid
  union all
  select 'COLUMN ' || r.name || '.' || quote_ident(a.attname),
    json_build_array(format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
      pg_get_expr(d.adbin, d.adrelid), a.attcollation::regcollation::text)::text
  from rel r join pg_attribute a on a.attrelid = r.oid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind not in ('i', 'I', 'S') and a.attnum > 0 and not a.attisdropped
  union all
  select 'CONSTRAINT ' || case when con.conrelid <> 0 then con.conrelid::regclass::text else con.contypid::regtype::text end
      || '.' || quote_ident(con.conname),
    json_build_array(con.contype, pg_get_constraintdef(con.oid))::text
  from pg_constraint con join pg_namespace n on n.oid = con.connamespace where n.nspname in ('public', 'drizzle')
  union all
  select 'STATISTICS ' || quote_ident(n.nspname) || '.' || quote_ident(s.stxname), pg_get_statisticsobjdef(s.oid)
  from pg_statistic_ext s join pg_namespace n on n.oid = s.stxnamespace where n.nspname in ('public', 'drizzle')`;

async function schemaObjects(sql: postgres.Sql): Promise<Map<string, string>> {
  const rows = await sql.begin(async (tx) => {
    // With only pg_catalog on the search path every name in a definition comes out schema-qualified.
    await tx`set local search_path to pg_catalog`;
    return await tx.unsafe<{ key: string; definition: string | null }[]>(SCHEMA_OBJECTS);
  });
  return new Map(rows.map((row) => [row.key, row.definition ?? ""]));
}

/**
 * Refuses a restored database whose schema differs in any object from `reference`, a database built from Saldo's own
 * migrations at the archive's level. Only the kind of object reaches the message; its name goes to the debug log.
 */
export async function matchReference(restored: postgres.Sql, reference: postgres.Sql): Promise<void> {
  const [actual, expected] = await Promise.all([schemaObjects(restored), schemaObjects(reference)]);
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    if (actual.get(key) === expected.get(key)) continue;
    const change = !actual.has(key) ? "missing" : !expected.has(key) ? "extra" : "different";
    console.debug(`Restore refused, schema object ${change}: ${JSON.stringify(key.slice(0, 200))}`);
    throw refuse(key.slice(0, key.indexOf(" ")));
  }
}
