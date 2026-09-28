/**
 * ДОСТУП К СЕРВЕРУ (M4): токен на разработчика.
 *
 * ЗАЧЕМ ИМЕННО ТАК. Сервер команды стоит в сети и обязан быть закрыт, но у
 * него нет и не должно быть своего каталога пользователей: люди уже есть в
 * гите, в мессенджере и в чьей-то голове, и заводить четвёртый список — это
 * работа, которую никто не станет поддерживать. Поэтому единица доступа —
 * ТОКЕН, выданный человеку или агенту под конкретного арендатора: он же
 * называет, кто пришёл (`subject`), и он же назначает арендатора, из которого
 * потом растёт вся изоляция (RLS по `myc.tenant`). Отзыв — одна строка в
 * базе, а не выкатка.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни OAuth, ни сессий с обновлением, ни ролей: всё
 * это нужно, когда у доступа есть степени. Здесь их две — «пустили» и «нет», —
 * и лишняя механика была бы кодом, который некому проверять. Шифрование
 * канала тоже не здесь: сервер ставится за обратным прокси с TLS, и это
 * сказано в развёртывании, а не подразумевается.
 *
 * ПРАВИЛА, КОТОРЫЕ ЛЕГКО НАРУШИТЬ СЛУЧАЙНО, И ПОТОМУ ЗАПИСАНЫ:
 *  - в базе лежит sha256 токена, не токен: копия базы не даёт доступа;
 *  - секрет не попадает ни в журнал, ни в ответ — только `id` и `subject`;
 *  - неизвестный, отозванный и просроченный токен отвечают ОДИНАКОВО, чтобы
 *    по ответу нельзя было перебирать существующие;
 *  - нет токенов в базе — доступа нет ни у кого (fail closed), а не «раз
 *    никого не завели, пускаем всех».
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PostgresDriver } from "@myc/store-postgres";

/** Префикс делает токен узнаваемым в вставленном тексте — и в сканерах утечек. */
export const TOKEN_PREFIX = "myc_";

/**
 * РОЛИ (§8.2). Роль отвечает на вопрос «кем выдан токен» — она видна в списке
 * и в журнале; на вопрос «что он может сейчас» отвечают ПРАВА. Проверяется
 * всегда по правам: роль, которую никто не проверяет, — украшение.
 */
export const ROLES = ["owner", "maintainer", "member", "agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Права: чтение, запись, взятие задач и администрирование сервера. */
export const SCOPES = ["read", "write", "claim", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** Умолчание прав у роли — то, что она значит, если не сузили явно. */
export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = Object.freeze({
  owner: ["read", "write", "claim", "admin"],
  maintainer: ["read", "write", "claim", "admin"],
  member: ["read", "write", "claim"],
  agent: ["read", "write", "claim"],
  viewer: ["read"],
});

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function parseScopes(raw: string): Scope[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
}

export interface Principal {
  readonly token_id: string;
  readonly tenant: string;
  readonly subject: string;
  readonly role: Role;
  readonly scopes: readonly Scope[];
  /** Пусто — все воркспейсы арендатора; иначе только этот. */
  readonly ws: string;
}

/** Есть ли у пришедшего это право. Единственное место, где это решается. */
export function can(who: Principal | undefined, scope: Scope): boolean {
  return who === undefined || who.scopes.includes(scope);
}

/**
 * Виден ли воркспейс этому токену. Токен, привязанный к одному проекту, о
 * чужих не должен даже узнавать — поэтому ответ наверху превращается в тот
 * же `notfound`, что у несуществующего воркспейса, а не в «нельзя».
 */
export function seesWorkspace(who: Principal | undefined, ws: string): boolean {
  return who === undefined || who.ws === "" || who.ws === ws;
}

export type AuthResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly code: "denied.no_token" | "denied.bad_token"; readonly msg: string };

/** sha256 в hex — то, что лежит в базе вместо секрета. */
export function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Новый секрет: 32 байта случайности, base64url без набивки. */
export function mintToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Токен запроса: заголовок `Authorization: Bearer …` или кука сессии браузера.
 * Заголовок сильнее куки: у машины он единственный способ, и путать их не надо.
 */
export function tokenOf(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (m !== null) return m[1]!;
  }
  const cookie = req.headers.get("cookie");
  if (cookie !== null) {
    for (const part of cookie.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE_NAME && rest.length > 0) return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export const COOKIE_NAME = "myc_token";

/** Одинаковый отказ на любую негодность токена — см. докстроку про перебор. */
const BAD: AuthResult = {
  ok: false,
  code: "denied.bad_token",
  msg: "unknown, revoked or expired token",
};

interface TokenRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject: string;
  readonly token_hash: string;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly role: string;
  readonly scopes: string;
  readonly ws: string;
}

export async function authenticate(
  pg: PostgresDriver,
  token: string | null,
  now = Date.now(),
): Promise<AuthResult> {
  if (token === null || token.length === 0) {
    return { ok: false, code: "denied.no_token", msg: "no token: send Authorization: Bearer <token>" };
  }
  const hash = tokenHash(token);
  const rows = await pg.raw<TokenRow>(
    `SELECT id, tenant_id, subject, token_hash, expires_at, revoked_at, role, scopes, ws
       FROM api_tokens WHERE token_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (row === undefined) return BAD;
  // Сверка ещё раз и постоянным временем: поиск по индексу — это поиск, а
  // равенство пусть подтверждает сравнение, которое не зависит от данных.
  const a = Buffer.from(row.token_hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return BAD;
  if (row.revoked_at !== null) return BAD;
  if (row.expires_at !== null && Number(row.expires_at) <= now) return BAD;

  // Отметка времени — попутно и без права уронить запрос: знать «когда этим
  // токеном ходили в последний раз» полезно, но не ценой отказа в доступе.
  void pg
    .raw("UPDATE api_tokens SET last_used_at = $1 WHERE id = $2", [now, row.id])
    .catch(() => undefined);

  const role: Role = isRole(row.role) ? row.role : "viewer";
  // Права из строки; пустая строка — права роли. Неизвестное слово в правах
  // молча отбрасывается разбором: право, которого нет, дать нельзя.
  const scopes = row.scopes.trim() === "" ? ROLE_SCOPES[role] : parseScopes(row.scopes);
  return {
    ok: true,
    principal: {
      token_id: row.id,
      tenant: row.tenant_id,
      subject: row.subject,
      role,
      scopes,
      ws: row.ws ?? "",
    },
  };
}

export interface NewToken {
  readonly id: string;
  readonly token: string;
  readonly tenant: string;
  readonly subject: string;
  readonly role: Role;
  readonly scopes: readonly Scope[];
  readonly ws: string;
}

/**
 * Выдать токен. Секрет возвращается ОДИН раз — здесь; в базу уходит только
 * его хеш, и повторно узнать секрет нельзя ни администратору, ни серверу.
 */
export async function addToken(
  pg: PostgresDriver,
  tenant: string,
  subject: string,
  opts: {
    readonly expiresAt?: number;
    readonly now?: number;
    readonly role?: Role;
    readonly scopes?: readonly Scope[];
    readonly ws?: string;
  } = {},
): Promise<NewToken> {
  if (tenant.length === 0 || subject.length === 0) {
    throw new Error("token: tenant and subject must not be empty");
  }
  const now = opts.now ?? Date.now();
  const token = mintToken();
  const id = `tok_${randomBytes(6).toString("hex")}`;
  const role: Role = opts.role ?? "member";
  const scopes = opts.scopes ?? ROLE_SCOPES[role];
  const ws = opts.ws ?? "";
  await pg.raw(
    `INSERT INTO api_tokens (id, tenant_id, subject, token_hash, created_at, expires_at, role, scopes, ws)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, tenant, subject, tokenHash(token), now, opts.expiresAt ?? null, role, scopes.join(","), ws],
  );
  return { id, token, tenant, subject, role, scopes, ws };
}

export async function revokeToken(pg: PostgresDriver, id: string, now = Date.now()): Promise<boolean> {
  const rows = await pg.raw<{ id: string }>(
    "UPDATE api_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING id",
    [now, id],
  );
  return rows.length > 0;
}

export interface TokenInfo {
  readonly id: string;
  readonly tenant: string;
  readonly subject: string;
  /** Что выдали: роль, права и воркспейс. Без них список не отвечает на
   * вопрос «кому что позволено», а он и есть причина в него смотреть. */
  readonly role: string;
  readonly scopes: string;
  readonly ws: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly last_used_at: number | null;
}

export async function listTokens(pg: PostgresDriver): Promise<TokenInfo[]> {
  const rows = await pg.raw<{
    id: string;
    tenant_id: string;
    subject: string;
    created_at: number;
    expires_at: number | null;
    revoked_at: number | null;
    last_used_at: number | null;
    role: string;
    scopes: string;
    ws: string;
  }>(
    `SELECT id, tenant_id, subject, created_at, expires_at, revoked_at, last_used_at, role, scopes, ws
       FROM api_tokens ORDER BY tenant_id, subject, created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    tenant: r.tenant_id,
    subject: r.subject,
    role: r.role,
    scopes: r.scopes,
    ws: r.ws ?? "",
    created_at: Number(r.created_at),
    expires_at: r.expires_at === null ? null : Number(r.expires_at),
    revoked_at: r.revoked_at === null ? null : Number(r.revoked_at),
    last_used_at: r.last_used_at === null ? null : Number(r.last_used_at),
  }));
}

/**
 * Кука сессии браузера. HttpOnly — скрипту страницы токен не нужен и не
 * достанется; SameSite=Strict — чужой сайт не сделает запрос от твоего имени;
 * Secure — когда снаружи https (за прокси об этом говорит X-Forwarded-Proto),
 * иначе кука не уедет по открытому каналу.
 */
export function sessionCookie(token: string, secure: boolean, maxAgeS = 30 * 24 * 60 * 60): string {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeS}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Снаружи https? За прокси об этом говорит заголовок, напрямую — протокол URL. */
export function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto !== null) return proto.split(",")[0]!.trim() === "https";
  return new URL(req.url).protocol === "https:";
}
