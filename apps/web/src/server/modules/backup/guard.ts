/**
 * A restored dump is untrusted, even with the right passphrase: a superuser may upload a foreign archive. Only what
 * Saldo's own pg_dump produces is restored (tables, their data, sequences, defaults, indexes and constraints in the
 * `public` and `drizzle` schemas), and afterwards the new database is checked for anything that could run code later
 * as the app's database user (functions, triggers, rules, views, foreign extensions, …) before it is swapped in.
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
