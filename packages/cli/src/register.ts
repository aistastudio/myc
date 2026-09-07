import { type Command, type Registry } from "./registry.ts";

/**
 * Единственное место, где команды попадают в реестр. Вынесено из main.ts
 * ровно затем, чтобы это было ЧИТАЕМО тестом: main.ts вызывает CLI прямо
 * при импорте, поэтому проверить его состав изнутри теста нельзя, и
 * команда `move` (R4) прожила написанной, оттестированной и невидимой —
 * 36 тестов строили собственный Registry и потому её отсутствия здесь
 * не замечали.
 *
 * ЗАГРУЗКА ОТЛОЖЕННАЯ, И ЭТО НЕ СТИЛЬ. Пока здесь стояли статические
 * импорты, модуль register.ts тянул ВЕСЬ граф команд — а его тянет main.ts,
 * то есть за инициализацию всех 36 модулей платил каждый запуск, включая
 * `myc --version`, который ни одной команды не исполняет. Замерено
 * чередующимся A/B (bench/coldstart-ab.ts, 45 раундов, load ~7.5 на 14
 * ядрах): бинарь с полным графом 24.07 мс p50, тот же бинарь без графа
 * 21.26 мс — 2.85 мс, 11.8% холодного старта, и каждая новая команда
 * добавляла бы к этому свою долю НАВСЕГДА и ВСЕМ запускам. Именно поэтому
 * сдвиг базовой линии не удавалось приписать одному изменению.
 *
 * ЧТО СТАТИЧНО, А ЧТО НЕТ. Статично только ИМЯ — его хватает разбору argv,
 * чтобы понять, какую команду просят, и `hasTop`/`paths`/`wire`, чтобы
 * знать состав. Всё остальное (summary, флаги, подкоманды, обработчик,
 * отрисовка) приезжает вместе с модулем: `run()` материализует ровно ту
 * команду, которую вызвали, и все сразу — только когда нужен полный список
 * (`--help`, подсказка по опечатке). Дублировать здесь флаги и summary
 * нельзя: две копии метаданных разъезжаются молча, а имя сверяется с
 * модулем и в `Registry.materialize`, и в register.test.ts.
 *
 * ПОРЯДОК СТРОК = порядок команд в `myc --help`.
 */
export function registerAll(registry: Registry): void {
  const lazy = (name: string, load: () => Promise<Command>): void =>
    registry.registerLazy(name, load);

  lazy("init", () => import("./commands/init.ts").then((m) => m.createInitCommand()));
  lazy("models", () => import("./commands/models.ts").then((m) => m.modelsCommand));
  lazy("model", () => import("./commands/roster.ts").then((m) => m.modelCommand));
  lazy("create", () => import("./commands/tasks.ts").then((m) => m.createCreateCommand()));
  lazy("task", () => import("./commands/tasks.ts").then((m) => m.createTaskCommand()));
  lazy("bug", () => import("./commands/tasks.ts").then((m) => m.createBugCommand()));
  lazy("epic", () => import("./commands/tasks.ts").then((m) => m.createEpicCommand()));
  lazy("msg", () => import("./commands/tasks.ts").then((m) => m.createMsgCommand()));
  lazy("update", () => import("./commands/tasks.ts").then((m) => m.createUpdateCommand()));
  lazy("claim", () => import("./commands/tasks.ts").then((m) => m.createClaimCommand()));
  lazy("release", () => import("./commands/tasks.ts").then((m) => m.createReleaseCommand()));
  lazy("close", () => import("./commands/tasks.ts").then((m) => m.createCloseCommand()));
  lazy("move", () => import("./commands/move.ts").then((m) => m.createMoveCommand()));
  lazy("attempt", () => import("./commands/attempt.ts").then((m) => m.createAttemptCommand()));
  lazy("report", () => import("./commands/attempt.ts").then((m) => m.createReportCommand()));
  lazy("show", () => import("./commands/show.ts").then((m) => m.createShowCommand()));
  lazy("list", () => import("./commands/list.ts").then((m) => m.createListCommand()));
  lazy("dep", () => import("./commands/dep.ts").then((m) => m.createDepCommand()));
  lazy("ready", () => import("./commands/ready.ts").then((m) => m.createReadyCommand()));
  lazy("prime", () => import("./commands/prime.ts").then((m) => m.createPrimeCommand()));
  lazy("viz", () => import("./commands/viz.ts").then((m) => m.createVizCommand()));
  lazy("export", () => import("./commands/export.ts").then((m) => m.createExportCommand()));
  lazy("import", () => import("./commands/import.ts").then((m) => m.createImportCommand()));
  lazy("import-beads", () =>
    import("./commands/import-beads.ts").then((m) => m.createImportBeadsCommand()));
  lazy("merge-driver", () =>
    import("./commands/merge-driver.ts").then((m) => m.createMergeDriverCommand()));
  lazy("bootstrap", () =>
    import("./commands/bootstrap.ts").then((m) => m.createBootstrapCommand()));
  lazy("remember", () => import("./commands/remember.ts").then((m) => m.createRememberCommand()));
  lazy("recall", () => import("./commands/recall.ts").then((m) => m.createRecallCommand()));
  lazy("search", () => import("./commands/search.ts").then((m) => m.createSearchCommand()));
  lazy("embedd", () => import("./commands/embedd.ts").then((m) => m.createEmbeddCommand()));
  lazy("reindex", () => import("./commands/reindex.ts").then((m) => m.createReindexCommand()));
  lazy("absorb", () => import("./commands/absorb.ts").then((m) => m.createAbsorbCommand()));
  lazy("absorb-session", () =>
    import("./hooks/absorb-session.ts").then((m) => m.createAbsorbSessionCommand()));
  // wire и mcp строятся ОТ реестра (им нужен его состав), поэтому загрузчик
  // замыкает тот самый registry, в который регистрируется.
  lazy("wire", () => import("./commands/wire.ts").then((m) => m.createWireCommand(registry)));
  lazy("unwire", () => import("./commands/wire.ts").then((m) => m.createUnwireCommand()));
  lazy("mcp", () => import("@myc/mcp").then((m) => m.createMcpCommand(registry)));
}
