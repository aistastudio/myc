/**
 * КЛИЕНТ СЕРВЕРА КОМАНДЫ.
 *
 * `myc --server https://myc.example/ ready` работает с общей базой команды
 * вместо локальной. Клиент зовёт ИМЕНОВАННЫЕ маршруты (§8.1), а не шлёт SQL
 * по сети: у каждого эндпоинта известная цена, её можно нормировать и
 * залогировать, а у «универсального /query» — нельзя.
 *
 * ВОРКСПЕЙС — ИЗ КОНФИГА, НЕ ИЗ ОКРУЖЕНИЯ. `--server` нужен только для
 * адреса: имя воркспейса по умолчанию читается из `.myc/workspace.toml`
 * (см. localWorkspaceSlug) — того же файла, что несёт slug в id узлов.
 * Вторая копия слага в MYC_SERVER/MYC_WS была источником рассинтонов
 * (aista/qmatic), и её больше нет; явные способы (--ws, путь адреса,
 * MYC_WS) остаются сильнее и нужны для чужого воркспейса.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ. Подделки локального хранилища: `StoreHandle`
 * несёт драйвер, каталоги воркспейса и рабочее дерево, и удалённый двойник
 * этого вранья стоил бы дороже честной ветки в командах. Команда либо умеет
 * удалённый режим и говорит об этом, либо ОТКАЗЫВАЕТ — молча работать с
 * локальной базой, когда человек указал сервер, нельзя: он увидит чужие
 * задачи и решит, что это общие.
 *
 * ТОКЕН НЕ ПОПАДАЕТ В КОМАНДНУЮ СТРОКУ. Он читается из `MYC_TOKEN`: аргументы
 * видны в `ps`, в истории оболочки и в журналах хуков, и секрету там не место.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitCode } from "./exit.ts";
import type { CommandContext, CommandFailure, CommandResult } from "./registry.ts";

/** Куда и с чем ходим. */
export interface RemoteTarget {
  readonly url: string;
  readonly token: string;
  /** Воркспейс в пути `/v1/ws/:ws/…`; по умолчанию — слаг локального воркспейса. */
  readonly ws: string;
}

export interface RemoteEnv {
  readonly MYC_SERVER?: string | undefined;
  readonly MYC_TOKEN?: string | undefined;
  readonly MYC_WS?: string | undefined;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * СЛАГ ИЗ КОНФИГА, А НЕ ВТОРОЙ ВВОД РУКАМИ. Единственный источник личности
 * воркспейса — `.myc/workspace.toml`: slug входит в id каждого узла, и имя
 * воркспейса на сервере обязано с ним совпадать (§4 deploy). Держать вторую
 * копию слага в MYC_SERVER/MYC_WS — чистый рассинтон: он же породил и
 * «would push 0» из-за aista/qmatic, и необходимость .envrc в каждом
 * проекте. Поэтому воркспейс по умолчанию ЧИТАЕТСЯ отсюда, а явные
 * способы (--ws, путь адреса, MYC_WS) остаются сильнее.
 *
 * Ищем `.myc/workspace.toml` в каталоге и родителях — той же тропой, что
 * поиск воркспейса при открытии (worktree тоже несёт коммитнутый конфиг).
 * Нет строки slug — возвращаем undefined и ведём себя как раньше: читать
 * myc_meta без базы здесь нельзя, а угадывать — тем более.
 */
export function localWorkspaceSlug(dir: string = process.cwd()): string | undefined {
  let at = dir;
  for (;;) {
    try {
      const m = /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(
        readFileSync(join(at, ".myc", "workspace.toml"), "utf8"),
      );
      if (m !== null) return m[1];
    } catch {
      // файла нет или не читается — поднимаемся выше
    }
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
}

/**
 * Разбор адреса сервера. Воркспейс можно задать в самом адресе
 * (`https://host/cherry`) — так у человека один параметр вместо двух.
 */
export function parseServer(raw: string): { url: string; ws: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const path = u.pathname.replace(/^\/+|\/+$/g, "");
  return { url: trimSlash(`${u.origin}`), ws: path };
}

/**
 * Цель удалённого режима или `undefined`, если сервер не задан. Отказы —
 * отдельным типом: «сервер задан, но токена нет» это ошибка человека, а не
 * «локальный режим».
 */
export function remoteTarget(
  ctx: CommandContext,
  env: RemoteEnv = process.env as RemoteEnv,
): { readonly kind: "none" } | { readonly kind: "remote"; readonly target: RemoteTarget } | {
  readonly kind: "bad";
  readonly failure: CommandFailure;
} {
  const raw = typeof ctx.flags["server"] === "string" ? String(ctx.flags["server"]) : env.MYC_SERVER;
  if (raw === undefined || raw.trim() === "") return { kind: "none" };
  const parsed = parseServer(raw.trim());
  if (parsed === undefined) {
    return {
      kind: "bad",
      failure: {
        ok: false,
        code: "usage.server",
        msg: `'${raw}' is not an http(s) address of a myc server`,
        exit: ExitCode.USAGE,
        hint: "example: --server https://myc.example/cherry",
      },
    };
  }
  const token = env.MYC_TOKEN ?? "";
  // ФОРМА ТОКЕНА ПРОВЕРЯЕТСЯ ЗДЕСЬ, до сети. Значение с пробелом, переводом
  // строки или не-ASCII в заголовок не кладётся вовсе: `fetch` бросает, и без
  // этой проверки человек читал бы «сервер не ответил» и чинил бы сеть вместо
  // испорченной при копировании строки.
  if (token !== "" && !/^[\x21-\x7e]+$/.test(token)) {
    return {
      kind: "bad",
      failure: {
        ok: false,
        code: "usage.token",
        msg: "MYC_TOKEN has characters that cannot go into an HTTP header — it looks mangled, not wrong",
        exit: ExitCode.USAGE,
        hint: "a myc token is myc_ followed by base32; copy it whole, without spaces or line breaks",
      },
    };
  }
  if (token === "") {
    return {
      kind: "bad",
      failure: {
        ok: false,
        code: "precond.no_token",
        msg: "the server needs an access token, and MYC_TOKEN is empty",
        exit: ExitCode.PRECOND,
        hint: "ask the server owner for one: myc serve --pg <url> --add-token <tenant>:<name>",
      },
    };
  }
  const explicitWs = typeof ctx.flags["ws"] === "string" ? String(ctx.flags["ws"]) : undefined;
  // Порядок: --ws → путь адреса → MYC_WS → СЛАГ ЛОКАЛЬНОГО КОНФИГА. Явные
  // способы сильнее: глядя на чужой воркспейс из своего каталога, человек
  // обязан назвать его сам. Пустой MYC_WS равен невыставленному.
  const envWs = env.MYC_WS?.trim() || undefined;
  const ws =
    explicitWs ??
    (parsed.ws !== "" ? parsed.ws : envWs) ??
    localWorkspaceSlug(ctx.globals.directory ?? process.cwd()) ??
    "";
  if (ws === "") {
    return {
      kind: "bad",
      failure: {
        ok: false,
        code: "usage.ws",
        msg:
          "the workspace is not set: it defaults to the slug of the local workspace " +
          "(.myc/workspace.toml), and this directory has none",
        exit: ExitCode.USAGE,
        hint: "run inside a workspace, or pass --ws / set MYC_WS / put the workspace in the server address",
      },
    };
  }
  return { kind: "remote", target: { url: parsed.url, token, ws } };
}

/** Конверт сервера — тот же, что у CLI (§2.3). */
interface Envelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly meta?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly msg: string; readonly hint?: string };
}

/**
 * Код выхода по коду отказа сервера. Пространство кодов общее с локальным
 * (§2.2), поэтому и отображение прямое: человеку не должно быть видно, откуда
 * пришёл отказ — из своей базы или из чужой.
 */
function exitOf(code: string): ExitCode {
  if (code.startsWith("usage.")) return ExitCode.USAGE;
  if (code.startsWith("notfound.")) return ExitCode.NOTFOUND;
  if (code.startsWith("conflict.")) return ExitCode.CONFLICT;
  if (code.startsWith("precond.")) return ExitCode.PRECOND;
  if (code.startsWith("denied.")) return ExitCode.DENIED;
  if (code.startsWith("degraded.")) return ExitCode.DEGRADED;
  if (code.startsWith("timeout.")) return ExitCode.TIMEOUT;
  return ExitCode.ERR;
}

export class RemoteError extends Error {
  constructor(
    readonly failure: CommandFailure,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/**
 * Клиент. Каждый метод — один маршрут; `data` возвращается как есть, потому
 * что форма ответа сервера и есть форма ответа команды (конверт общий).
 */
export class RemoteClient {
  constructor(
    private readonly target: RemoteTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get ws(): string {
    return this.target.ws;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.target.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.target.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      // Сеть не ответила — это ДЕГРАДАЦИЯ, а не ошибка запроса: сервер может
      // быть выключен, и человеку важно отличить это от «задача не найдена».
      throw new RemoteError(
        {
          ok: false,
          code: "degraded.unreachable",
          msg: `the server at ${this.target.url} did not answer: ${e instanceof Error ? e.message : String(e)}`,
          exit: ExitCode.DEGRADED,
        },
        "unreachable",
      );
    }
    const text = await res.text();
    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      throw new RemoteError(
        {
          ok: false,
          code: "internal.bad_answer",
          msg: `the server answered ${res.status} with something that is not a myc envelope`,
          exit: ExitCode.ERR,
        },
        "bad answer",
      );
    }
    if (env.ok !== true) {
      const code = env.error?.code ?? `internal.http_${res.status}`;
      throw new RemoteError(
        {
          ok: false,
          code,
          msg: env.error?.msg ?? `the server answered ${res.status}`,
          exit: exitOf(code),
          ...(env.error?.hint === undefined ? {} : { hint: env.error.hint }),
        },
        code,
      );
    }
    return { data: env.data, meta: env.meta ?? {} };
  }

  /** Воркспейсы, доступные токену. */
  async workspaces(): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("GET", "/v1/ws");
  }

  async listNodes(query: Readonly<Record<string, string | number | undefined>>): Promise<{
    data: unknown;
    meta: Record<string, unknown>;
  }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return this.call("GET", `/v1/ws/${encodeURIComponent(this.target.ws)}/nodes${qs === "" ? "" : `?${qs}`}`);
  }

  async getNode(id: string): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("GET", `/v1/ws/${encodeURIComponent(this.target.ws)}/nodes/${encodeURIComponent(id)}`);
  }

  async createNode(input: unknown): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("POST", `/v1/ws/${encodeURIComponent(this.target.ws)}/nodes`, input);
  }

  async patchNode(id: string, patch: unknown): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call(
      "PATCH",
      `/v1/ws/${encodeURIComponent(this.target.ws)}/nodes/${encodeURIComponent(id)}`,
      patch,
    );
  }

  async addEdge(edge: unknown): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("POST", `/v1/ws/${encodeURIComponent(this.target.ws)}/edges`, edge);
  }

  async removeEdge(edge: unknown): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("DELETE", `/v1/ws/${encodeURIComponent(this.target.ws)}/edges`, edge);
  }

  async ready(query: Readonly<Record<string, string | number | undefined>>): Promise<{
    data: unknown;
    meta: Record<string, unknown>;
  }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return this.call("GET", `/v1/ws/${encodeURIComponent(this.target.ws)}/ready${qs === "" ? "" : `?${qs}`}`);
  }

  async prime(query: Readonly<Record<string, string | number | undefined>>): Promise<{
    data: unknown;
    meta: Record<string, unknown>;
  }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return this.call("GET", `/v1/ws/${encodeURIComponent(this.target.ws)}/prime${qs === "" ? "" : `?${qs}`}`);
  }

  /** Один круг обмена (§9.5). Повторяется вызывающим, пока `more`. */
  async sync(body: {
    readonly site_id: string;
    readonly have: Readonly<Record<string, string>>;
    readonly ops: readonly unknown[];
  }): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("POST", `/v1/ws/${encodeURIComponent(this.target.ws)}/sync`, body);
  }

  async claim(id: string, leaseMinutes?: number): Promise<{ data: unknown; meta: Record<string, unknown> }> {
    return this.call("POST", `/v1/ws/${encodeURIComponent(this.target.ws)}/ready/claim`, {
      id,
      ...(leaseMinutes === undefined ? {} : { lease_minutes: leaseMinutes }),
    });
  }
}

/**
 * Ветка удалённого режима для команды.
 *
 * `undefined` — сервер не задан, команда работает как работала. Иначе здесь
 * уже всё: разобранная цель, клиент и перевод отказов сервера в обычный
 * `CommandFailure`. Вызывается ДО открытия локальной базы — иначе команда
 * успела бы прочитать чужие данные прежде, чем поняла, что её просили о
 * других.
 */
export async function remoteRun(
  ctx: CommandContext,
  fn: (client: RemoteClient) => Promise<CommandResult>,
  env: RemoteEnv = process.env as RemoteEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<CommandResult | undefined> {
  const target = remoteTarget(ctx, env);
  if (target.kind === "none") return undefined;
  if (target.kind === "bad") return target.failure;
  try {
    return await fn(new RemoteClient(target.target, fetchImpl));
  } catch (e) {
    if (e instanceof RemoteError) return e.failure;
    throw e;
  }
}
