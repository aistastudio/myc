import type { SwarmMigration } from "./types.ts";

/**
 * Запуск попытки, версия 6 (memory-v3f81y9vfrq0). Одна строка = «эту
 * попытку выполнял ВОТ ЭТОТ процесс ВОТ В ЭТОЙ сессии по вот этому
 * поручению». Отдельная таблица, а не колонки в swarm_attempt, по трём
 * причинам, и каждая — не вкусовая:
 *
 * - У ЗАПУСКА ДРУГОЕ ВРЕМЯ ЖИЗНИ. Попытка кончается вердиктом; процесс —
 *   нет. Ровно на этом расхождении 2026-09-07 три агентских процесса
 *   провисели 6 ч 52 мин и держали 380 МБ после того, как их работа была
 *   принята и терминал освобождён: `worker-release` снимает учётную
 *   запись терминала, а `claude --resume <uuid>` продолжает жить. Пока
 *   «работа» и «процесс» — одна строка с одним finished_at, различить
 *   «работает» и «завершено, но живо» нечем.
 * - ЗАПУСК ЕСТЬ НЕ У КАЖДОЙ ПОПЫТКИ. Ретроспективная попытка из
 *   `myc close --verdict` процесса не имела: строки запуска у неё просто
 *   нет, и это честнее, чем полтора десятка NULL-колонок в основной
 *   таблице.
 * - ВНЕШНИЙ КЛЮЧ — БАРЬЕР. PRAGMA foreign_keys=ON держит соединение, и
 *   запуск без попытки не записывается даже прямым INSERT.
 *
 * ПОЧЕМУ ЗДЕСЬ ЕСТЬ *_source. Связь попытки с сессией до этой миграции
 * не хранилась вовсе — её ВЫВОДИЛИ постфактум перебором стенограмм по
 * строке брифа `Задача myc: <id>` (scripts/attempt-cost.ts). Вывод молча
 * ломается, стоит написать бриф иначе: 2026-09-07 так и вышло для двух
 * агентов. Поэтому хранится не только сама связь, но и то, ОТКУДА она
 * известна: 'env' — процесс сам себя назвал при старте, 'flag' — назвал
 * запускающий, 'search' — найдено перебором (тот самый ненадёжный путь,
 * оставленный запасным). Отчёт обязан уметь отличить записанное от
 * угаданного, иначе повторится ровно та же тихая поломка.
 *
 * ЧТО ЗДЕСЬ НЕ ХРАНИТСЯ И ПОЧЕМУ. Нет ни «убить», ни «сигнал», ни очереди
 * на снятие: myc ведёт ЗАПИСЬ, а снимает процессы тот, кто их запускал.
 * `proc_state` — это то, что НАБЛЮДАЛИ (running/exited/unknown), и правится
 * оно только в сторону exited: воскрешать pid запись не имеет права.
 *
 * Один оператор на миграцию.
 */
const SQL = `CREATE TABLE swarm_attempt_run (
  attempt_id      TEXT PRIMARY KEY REFERENCES swarm_attempt(attempt_id),
  session_id      TEXT,                   -- uuid стенограммы харнесса
  session_source  TEXT NOT NULL DEFAULT 'none'
                  CHECK (session_source IN ('env','flag','search','none')),
  transcript_path TEXT,                   -- файл стенограммы, если известен точно
  dispatch_id     TEXT,                   -- ctx_* оркестратора
  dispatch_source TEXT NOT NULL DEFAULT 'none'
                  CHECK (dispatch_source IN ('env','flag','lookup','none')),
  run_id          TEXT,                   -- run_* оркестратора
  terminal        TEXT,                   -- term_*: ключ соединения с оркестратором
  pane_key        TEXT,                   -- <tab>:<leaf>, ключ к pid у оркестратора
  agent_pid       INTEGER,                -- pid процесса агента
  pid_source      TEXT NOT NULL DEFAULT 'none'
                  CHECK (pid_source IN ('env','flag','none')),
  harness_build   TEXT,                   -- версия харнесса, как он себя назвал
  proc_state      TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (proc_state IN ('running','exited','unknown')),
  proc_checked_at INTEGER,                -- когда последний раз смотрели на pid
  proc_exited_at  INTEGER,                -- когда впервые увидели, что pid мёртв
  git_head        TEXT,                   -- HEAD на момент старта: база для diff
  files_touched   TEXT,                   -- JSON string[] на finish
  recorded_at     INTEGER NOT NULL
)`;

export const migration006SwarmAttemptRun: SwarmMigration = {
  version: 6,
  name: "swarm_attempt_run",
  sql: SQL,
  objects: ["swarm_attempt_run"],
};
