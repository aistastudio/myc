/**
 * АДМИНКА СЕРВЕРА (M4) — то же, что `myc viz` для локальной базы, но про
 * сервер: не граф и не карточки, а кто на этом сервере есть и в каком он
 * состоянии. Только чтение; правок отсюда нет вовсе — у сервера пока нет
 * пути записи, и рисовать кнопку, которой нечего делать, значит врать.
 *
 * ЧИТАЕТ ЧЕРЕЗ ТУ ЖЕ ИЗОЛЯЦИЮ, ЧТО И БОЕВОЙ ЗАПРОС. Список арендаторов
 * берётся из серверного реестра `tenants` (он вне RLS — это не данные
 * арендатора, а перечень), а каждое число считается ПОД СВОИМ арендатором
 * через `withTenant`. Роль с BYPASSRLS дала бы то же самое одним запросом и
 * ровно там, где изоляцию объясняют, — поэтому её здесь нет.
 *
 * ПЕРВОЕ, ЧТО ПОКАЗЫВАЕТ СТРАНИЦА, — СОБЛЮДАЕТСЯ ЛИ ИЗОЛЯЦИЯ ВООБЩЕ.
 * Суперпользователь Postgres не подчиняется RLS ни при каких настройках, и
 * сервер, подключённый суперпользователем, изоляции не имеет — независимо от
 * того, что написано в схеме. Это поймано смоком схемы (первый прогон
 * «доказал» изоляцию, которой не было), и поэтому вынесено наверх красным.
 */

import type { PostgresDriver } from "@myc/store-postgres";

export interface AdminOverview {
  /** Роль соединения и то, обходит ли она RLS. */
  readonly role: string;
  readonly superuser: boolean;
  readonly bypass_rls: boolean;
  readonly postgres: string;
  readonly pgvector: string | null;
  readonly schema: string | null;
  /** Сколько таблиц под политикой и сколько из них с FORCE. */
  readonly rls: { readonly tables: number; readonly with_policy: number; readonly forced: number };
  readonly database_bytes: number;
  readonly warn: readonly { readonly code: string; readonly msg: string }[];
}

export interface AdminProject {
  readonly scope: string;
  readonly nodes: number;
  readonly open_tasks: number;
  readonly updated_at: number | null;
}

export interface AdminTenant {
  readonly id: string;
  readonly title: string;
  readonly created_at: number;
  readonly projects: readonly AdminProject[];
  readonly nodes: number;
  readonly oplog: number;
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function adminOverview(pg: PostgresDriver): Promise<AdminOverview> {
  const [who] = await pg.raw<{ role: string; superuser: boolean; bypass: boolean; ver: string }>(
    `SELECT current_user AS role,
            rolsuper  AS superuser,
            rolbypassrls AS bypass,
            version() AS ver
       FROM pg_roles WHERE rolname = current_user`,
  );
  const [ext] = await pg.raw<{ v: string | null }>(
    "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
  );
  const [schema] = await pg.raw<{ v: number | null }>(
    "SELECT max(version) AS v FROM schema_migrations",
  );
  const [rls] = await pg.raw<{ tables: number; with_policy: number; forced: number }>(
    `SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') AS tables,
            (SELECT count(DISTINCT tablename) FROM pg_policies WHERE schemaname = 'public') AS with_policy,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity) AS forced`,
  );
  const [size] = await pg.raw<{ bytes: number }>(
    "SELECT pg_database_size(current_database()) AS bytes",
  );

  const superuser = who?.superuser === true;
  const bypass = who?.bypass === true;
  const warn: { code: string; msg: string }[] = [];
  if (superuser || bypass) {
    // И2: деградация обязана быть названа, а не подразумеваться.
    warn.push({
      code: "degraded.rls_bypassed",
      msg:
        `the server is connected as '${who?.role ?? "?"}', a role that bypasses row level security ` +
        "— tenant isolation is NOT in effect; connect as myc_app",
    });
  }
  const withPolicy = n(rls?.with_policy);
  if (withPolicy > 0 && n(rls?.forced) < withPolicy) {
    warn.push({
      code: "degraded.rls_not_forced",
      msg: `${withPolicy - n(rls?.forced)} tables have a policy without FORCE — the table owner bypasses it`,
    });
  }

  return {
    role: who?.role ?? "?",
    superuser,
    bypass_rls: bypass,
    postgres: (who?.ver ?? "").split(" ").slice(0, 2).join(" "),
    pgvector: ext?.v ?? null,
    schema: schema?.v === null || schema?.v === undefined ? null : `v${schema.v}`,
    rls: { tables: n(rls?.tables), with_policy: withPolicy, forced: n(rls?.forced) },
    database_bytes: n(size?.bytes),
    warn,
  };
}

export async function adminTenants(pg: PostgresDriver): Promise<AdminTenant[]> {
  const rows = await pg.raw<{ id: string; title: string; created_at: number }>(
    "SELECT id, title, created_at FROM tenants ORDER BY id",
  );
  const out: AdminTenant[] = [];
  for (const t of rows) {
    // Под арендатором: числа считает та же политика, что обслуживает боевой
    // запрос, — значит на странице видно ровно то, что видит он сам.
    const projects = await pg.withTenant(t.id, async (tx) =>
      tx.raw<{ scope: string; nodes: number; open_tasks: number; updated_at: number | null }>(
        `SELECT scope,
                count(*) AS nodes,
                count(*) FILTER (WHERE kind = 'task' AND status = 'open') AS open_tasks,
                max(updated_at) AS updated_at
           FROM nodes WHERE deleted_at IS NULL
          GROUP BY scope ORDER BY scope`,
      ),
    );
    const oplog = await pg.withTenant(t.id, async (tx) =>
      tx.raw<{ n: number }>("SELECT count(*) AS n FROM oplog"),
    );
    out.push({
      id: t.id,
      title: t.title,
      created_at: n(t.created_at),
      projects: projects.map((p) => ({
        scope: p.scope,
        nodes: n(p.nodes),
        open_tasks: n(p.open_tasks),
        updated_at: p.updated_at === null ? null : n(p.updated_at),
      })),
      nodes: projects.reduce((s, p) => s + n(p.nodes), 0),
      oplog: n(oplog[0]?.n),
    });
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const when = (ms: number | null): string =>
  ms === null || ms === 0 ? "—" : new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/**
 * Страница целиком в одном ответе: ни одного внешнего запроса, как у `myc
 * viz` (там это решение про вшитые ассеты, здесь — та же причина: админка
 * сервера не имеет права зависеть от сети, чтобы показать, что сервер жив).
 */
export function renderAdminPage(
  o: AdminOverview,
  tenants: readonly AdminTenant[],
  who?: { readonly subject: string; readonly tenant: string },
): string {
  const banner = o.warn
    .map(
      (w) =>
        `<div class="warn"><b>${esc(w.code)}</b> — ${esc(w.msg)}</div>`,
    )
    .join("");
  const rows = tenants
    .map((t) => {
      const projects =
        t.projects.length === 0
          ? `<tr><td colspan="4" class="dim">empty</td></tr>`
          : t.projects
              .map(
                (p) =>
                  `<tr><td>${esc(p.scope)}</td><td class="num">${p.nodes}</td>` +
                  `<td class="num">${p.open_tasks}</td><td class="dim">${when(p.updated_at)}</td></tr>`,
              )
              .join("");
      return (
        `<section><h2>${esc(t.id)}${t.title === "" ? "" : ` — ${esc(t.title)}`}</h2>` +
        `<p class="dim">${t.nodes} nodes · ${t.oplog} oplog rows · created ${when(t.created_at)}</p>` +
        `<table><thead><tr><th>project</th><th>nodes</th><th>open tasks</th><th>last change</th></tr></thead>` +
        `<tbody>${projects}</tbody></table></section>`
      );
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>myc — server admin</title>
<style>
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem auto;max-width:56rem;color:#1a1a1a}
 h1{font-size:1.1rem;margin:0 0 .25rem} h2{font-size:1rem;margin:1.5rem 0 .25rem}
 table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #eee}
 th{font-weight:600;color:#555} .num{text-align:right} .dim{color:#777}
 .warn{background:#fff3f3;border:1px solid #e88;padding:.5rem .75rem;margin:.5rem 0}
 .facts{color:#555;margin:.25rem 0 1rem}
</style></head><body>
<h1>myc — server admin</h1>
${who === undefined ? "" : `<div class="facts">signed in as ${esc(who.subject)} · tenant ${esc(who.tenant)} · <a href="/v1/auth/session">sign out</a></div>`}
<div class="facts">${esc(o.postgres)} · pgvector ${esc(o.pgvector ?? "none")} · schema ${esc(o.schema ?? "none")} ·
 role ${esc(o.role)} · RLS: policy on ${o.rls.with_policy} of ${o.rls.tables} tables, FORCE on ${o.rls.forced} ·
 database ${mb(o.database_bytes)}</div>
${banner}
${tenants.length === 0 ? '<p class="dim">no tenants: the tenants registry is empty</p>' : rows}
</body></html>`;
}
