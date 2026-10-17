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
  /** Откуда адрес: флаг --server, конфиг репозитория (.myc/workspace.toml) или профильное окружение. */
  readonly source: "flag" | "config" | "env";
  /** Откуда токен: .myc/token репозитория или профильный MYC_TOKEN. */
  readonly tokenSource: "file" | "env" | null;
}

export interface RemoteEnv {
  readonly MYC_SERVER?: string | undefined;
  readonly MYC_TOKEN?: string | undefined;
  readonly MYC_WS?: string | undefined;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Режим обмена воркспейса (§9.5): `manual` — только явный `myc sync`. */
export type SyncMode = "manual" | "auto";

/** Что разобрано в `.myc/workspace.toml`. */
export interface WorkspaceConfig {
  readonly slug?: string;
  readonly sync?: SyncMode;
  /** Строка sync, которую разобрать не удалось: её называют, а не проглатывают. */
  readonly syncInvalid?: string;
  /** Сервер этого воркспейса (полный адрес, возможно с путём воркспейса). */
  readonly server?: string;
}

/**
 * СЛАГ И РЕЖИМ ОБМЕНА ИЗ КОНФИГА, А НЕ ВТОРОЙ ВВОД РУКАМИ. Единственный
 * источник личности воркспейса — `.myc/workspace.toml`: slug входит в id
 * каждого узла, и имя воркспейса на сервере обязано с ним совпадать (§4
 * deploy). Держать вторую копию слага в MYC_SERVER/MYC_WS — чистый
 * рассинтон: он же породил и «would push 0» из-за aista/qmatic, и
 * необходимость .envrc в каждом проекте. Поэтому воркспейс по умолчанию
 * ЧИТАЕТСЯ отсюда, а явные способы (--ws, путь адреса, MYC_WS) остаются
 * сильнее.
 *
 * Тот же файл несёт `sync = "auto"` — переключатель фонового обмена (§9.5):
 * он коммитится и живёт рядом с личностью воркспейса, потому что режим
 * обмена — свойство воркспейса, а не отдельной машины. MYC_SYNC —
 * личный override поверх него.
 *
 * Ищем `.myc/workspace.toml` в каталоге и родителях — той же тропой, что
 * поиск воркспейса при открытии (worktree тоже несёт коммитнутый конфиг).
 * Нет строки slug — возвращаем undefined и ведём себя как раньше: читать
 * myc_meta без базы здесь нельзя, а угадывать — тем более. `sync` берётся
 * из БЛИЖАЙШЕЙ читаемой копии файла, slug — как раньше, из первой, где он
 * есть.
 */
export function localWorkspaceConfig(dir: string = process.cwd()): WorkspaceConfig {
  let at = dir;
  let sync: SyncMode | undefined;
  let syncInvalid: string | undefined;
  let server: string | undefined;
  for (;;) {
    try {
      const text = readFileSync(join(at, ".myc", "workspace.toml"), "utf8");
      if (sync === undefined) {
        const raw = /^sync\s*=\s*"([a-z]+)"/m.exec(text)?.[1];
        if (raw === "auto" || raw === "manual") sync = raw;
        else if (raw !== undefined) syncInvalid = raw;
      }
      if (server === undefined) {
        const raw = /^server\s*=\s*"([^"\n]+)"/m.exec(text)?.[1]?.trim();
        if (raw !== undefined && raw !== "") server = raw;
      }
      const slug = /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(text)?.[1];
      if (slug !== undefined) {
        return {
          slug,
          ...(sync !== undefined ? { sync } : {}),
          ...(syncInvalid !== undefined ? { syncInvalid } : {}),
          ...(server !== undefined ? { server } : {}),
        };
      }
    } catch {
      // файла нет или не читается — поднимаемся выше
    }
    const parent = dirname(at);
    if (parent === at) {
      return {
        ...(sync !== undefined ? { sync } : {}),
        ...(syncInvalid !== undefined ? { syncInvalid } : {}),
        ...(server !== undefined ? { server } : {}),
      };
    }
    at = parent;
  }
}

export function localWorkspaceSlug(dir: string = process.cwd()): string | undefined {
  return localWorkspaceConfig(dir).slug;
}

/**
 * РЕЖИМ ОБМЕНА: MYC_SYNC (личный override) поверх `sync` из конфига, дальше
 * умолчание `manual`. Неразобранная строка — режим manual плюс имя того, что
 * не разобралось: тишина тут означала бы «фон включён/выключен, и никто не
 * знает почему».
 */
export function syncModeFrom(
  env: Readonly<Record<string, string | undefined>>,
  config: WorkspaceConfig,
): {
  readonly mode: SyncMode;
  readonly source: "env" | "config" | "default";
  readonly invalid: string | undefined;
} {
  const raw = env.MYC_SYNC?.trim();
  if (raw === "auto" || raw === "manual") return { mode: raw, source: "env", invalid: undefined };
  if (config.sync !== undefined) {
    return { mode: config.sync, source: "config", invalid: config.syncInvalid };
  }
  const invalid = raw !== undefined && raw !== "" ? raw : config.syncInvalid;
  return { mode: "manual", source: "default", invalid };
}

/**
 * ТОКЕН РЕПОЗИТОРИЯ: `.myc/token` — свой на каждый сервер. Репозитории
 * разных компаний ходят на разные серверы с разными токенами, и держать их
 * все в профильном MYC_TOKEN значит каждый раз выбирать, чьим токеном
 * писать не туда. Файл лежит в `.myc` и в .gitignore (MYC_GITIGNORE_LINES):
 * токен — не личность воркспейса, коммититься он не обязан и не должен.
 * Ищется той же тропой вверх, что конфиг (worktree несёт конфиг основного
 * дерева).
 */
export function localTokenFile(dir: string = process.cwd()): string | undefined {
  let at = dir;
  for (;;) {
    try {
      const token = readFileSync(join(at, ".myc", "token"), "utf8").trim();
      if (token !== "") return token;
    } catch {
      // файла нет или не читается — поднимаемся выше
    }
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
}

/**
 * СЫРАЯ ЦЕЛЬ ОБМЕНА ДЛЯ ФОНОВЫХ ПРОВЕРОК «ЕСТЬ ЛИ КУДА»: конфиг репозитория
 * обгоняет профильный MYC_SERVER — та же логика, что в remoteTarget. Полной
 * проверки (формат адреса, токен) здесь нет: это предварительный фильтр
 * дренажа, полный разбор — у remoteTarget при самом обмене.
 */
export function ambientServer(
  env: Readonly<Record<string, string | undefined>>,
  dir?: string,
): string | undefined {
  const cfgServer = localWorkspaceConfig(dir ?? process.cwd()).server;
  if (cfgServer !== undefined) return cfgServer;
  const fromEnv = env.MYC_SERVER?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
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
  env?: RemoteEnv,
  opts: { readonly configSuffices?: boolean } = {},
): { readonly kind: "none" } | { readonly kind: "remote"; readonly target: RemoteTarget } | {
  readonly kind: "bad";
  readonly failure: CommandFailure;
} {
  // Окружение ВЫЗОВА важнее процесса: у CLI это одно и то же, а MCP-сервер
  // передаёт обрезанное — без профильных MYC_SERVER/MYC_TOKEN/MYC_WS, чтобы
  // инструменты писали в репозиторию, а не на сервер профиля (memory-z2gy643ksmkw).
  const eff: RemoteEnv =
    env ?? (ctx.globals.env as RemoteEnv | undefined) ?? (process.env as RemoteEnv);
  const flagRaw0 = typeof ctx.flags["server"] === "string" ? String(ctx.flags["server"]) : undefined;
  const flagRaw = flagRaw0?.trim() ?? "";
  const dir = ctx.globals.directory ?? process.cwd();
  // ПОРЯДОК ЦЕЛИ: --server (явный запрос одного вызова) → server КОНФИГА
  // РЕПОЗИТОРИЯ → профильный MYC_SERVER. Конфиг обгоняет профиль НАМЕРЕННО:
  // профиль глобален и не знает, в чьей репозитории сидит человек, а конфиг
  // закоммичен репозиторием и говорит, чей это сервер. В репозиториях разных
  // компаний это неудобство, а защита — чужие данные не уедут не туда молча.
  const cfgServer = localWorkspaceConfig(dir).server;
  const envRaw = (eff.MYC_SERVER ?? "").trim();
  // НО РЕЖИМ ОТ КОНФИГА НЕ ВКЛЮЧАЕТСЯ: удалённый режим требует явного спроса
  // (флаг или профиль), иначе `server` в репозитории перевёл бы каждую
  // remote-команду в сетевой режим — сеть в горячем пути вопреки §9.5.
  // Исключение — команды, которые сами просят сервер (sync, `configSuffices`):
  // у них конфиг и есть ответ «куда».
  const asked = flagRaw !== "" || envRaw !== "";
  if (!asked && !(opts.configSuffices === true && cfgServer !== undefined)) {
    return { kind: "none" };
  }
  const source: RemoteTarget["source"] =
    flagRaw !== "" ? "flag" : cfgServer !== undefined ? "config" : "env";
  const raw = flagRaw !== "" ? flagRaw : (cfgServer ?? envRaw);
  if (raw === "") return { kind: "none" };
  const parsed = parseServer(raw.trim());
  if (parsed === undefined) {
    return {
      kind: "bad",
      failure: {
        ok: false,
        code: "usage.server",
        msg:
          `'${raw}' is not an http(s) server address` +
          (source === "config" ? " (it comes from `server` in .myc/workspace.toml)" : ""),
        exit: ExitCode.USAGE,
        hint: "example: --server https://myc.example/cherry",
      },
    };
  }
  // ТОКЕН: `.myc/token` репозитория обгоняет профильный MYC_TOKEN — та же
  // логика, что у адреса: принадлежность репозитория важнее фонового
  // окружения. Профильный токен остаётся для реп без файла.
  const fileToken = localTokenFile(dir);
  const token = fileToken ?? eff.MYC_TOKEN ?? "";
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
        msg: "the server needs an access token, and neither .myc/token nor MYC_TOKEN has one",
        exit: ExitCode.PRECOND,
        hint:
          "ask the server owner for one: myc serve --pg <url> --add-token <tenant>:<name> — " +
          "put it in MYC_TOKEN or in .myc/token of this repository (gitignored)",
      },
    };
  }
  const explicitWs = typeof ctx.flags["ws"] === "string" ? String(ctx.flags["ws"]) : undefined;
  // Порядок: --ws → путь адреса → MYC_WS → СЛАГ ЛОКАЛЬНОГО КОНФИГА. Явные
  // способы сильнее: глядя на чужой воркспейс из своего каталога, человек
  // обязан назвать его сам. Пустой MYC_WS равен невыставленному.
  const envWs = eff.MYC_WS?.trim() || undefined;
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
  return { kind: "remote", target: { url: parsed.url, token, ws, source, tokenSource: fileToken !== undefined ? "file" : "env" } };
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
  opts: { readonly configSuffices?: boolean } = {},
  env?: RemoteEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<CommandResult | undefined> {
  // env по умолчанию не задаётся: remoteTarget сам спустится до ctx.globals.env
  // и дальше до process.env — единая цепочка для CLI и MCP.
  const target = remoteTarget(ctx, env, opts);
  if (target.kind === "none") return undefined;
  if (target.kind === "bad") return target.failure;
  try {
    return await fn(new RemoteClient(target.target, fetchImpl));
  } catch (e) {
    if (e instanceof RemoteError) return e.failure;
    throw e;
  }
}
