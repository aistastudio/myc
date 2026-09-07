/**
 * Корпус для постоянной проверки языкового качества эмбеддера (S46).
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ВЫГЛЯДИТ ИМЕННО ТАК. Прошлые проверки качества были
 * слепы к языку по построению: косинус «до и после квантизации» к языку
 * безразличен, а recall@10 = 1.000 мерялся на синтетическом корпусе, где
 * перефразировку строил сам тест, а векторы давал оракул из теста. Метрика,
 * посчитанная на данных, которые сгенерировал тот же тест, проверяет тест,
 * а не систему.
 *
 * Поэтому здесь:
 *  · `doc` — ДОСЛОВНЫЙ текст, уже написанный в этом проекте для дела:
 *    русские — из памяти проекта (`bd memories`) и решений §10, английские —
 *    из справки CLI, которую читает пользователь. Ни одна строка не
 *    сочинена ради теста;
 *  · `query` — как о том же спросил бы человек, НАМЕРЕННО другими словами:
 *    общих знаменательных слов с документом почти нет, поэтому лексическая
 *    ветка такую пару не свяжет и мерится ровно семантика;
 *  · `UNRELATED_*` — обычные бытовые тексты того же языка: контроль
 *    «далёкой» пары. Тот самый рецепт борща, который у английской модели
 *    оказался ближе к оплогу, чем вопрос про слияние журналов.
 */

export interface SeparationPair {
  /** Запрос человека — другими словами, чем документ. */
  readonly query: string;
  /** Документ дословно из проекта. */
  readonly doc: string;
}

export const RU_PAIRS: readonly SeparationPair[] = [
  {
    query: "почему хвост журнала нельзя доставать обычной сортировкой",
    doc: "В нашей сборке SQLite запрос вида SELECT ... WHERE site_id=? ORDER BY hlc DESC LIMIT 1 по индексу (site_id, hlc) строит TEMP B-TREE по всем строкам сайта (12 мс на 120k оплога). Хвост индекса читать через max(hlc) — min/max-оптимизация, один спуск по дереву (~1 мкс). Проверять EXPLAIN QUERY PLAN на 'USE TEMP B-TREE'.",
  },
  {
    query: "что происходит, когда пропал доступ к платной модели",
    doc: "И2 деградация обязана быть громкой. Никакого молчаливого фолбэка: у memora отказ эмбеддингов тихо переключает на TF-IDF, и база наполняется мешками ключевых слов, продолжая выглядеть здоровой. У нас качество пишется в саму строку узла (verdict_source, distilled_by), видно запросом, отражено в meta.degraded[] всех поверхностей и в myc doctor.",
  },
  {
    query: "долго ли новому человеку разворачивать проект с нуля",
    doc: "S42: в git только оплог, проекции — кеш .myc/projections с .gitignore '*'. Замер на 100 003 операциях (14 221 узел, 7 110 рёбер): git clone 51 мс, открыть+мигрировать базу 7 мс, import с пересборкой кеша 2,54 с (~26 мкс/оп), итого клон→рабочее состояние 2,6 с.",
  },
  {
    query: "разрешено ли дёргать внешние сервисы прямо во время ответа",
    doc: "И1 скорость — ограничение, а не оптимизация: в горячем пути myc запрещены сеть, вызовы LLM и полные пересчёты индексов. Запись идёт одним синхронным шагом в append-only оплог, всё дорогое делает фоновый дистиллятор. Бюджеты: prime p99 30 мс, чтение 3 мс, поиск 25 мс на 100k, запись 5 мс, холодный старт 60 мс.",
  },
  {
    query: "отчего мы отказались писать собственный разбор исходников",
    doc: "И3 свой код-граф не пишем. graft стоит 40–300 мс на вызов против бюджета recall в 25 мс, поэтому адаптер работает только в фоне и по явным командам. myc хранит свои якоря repo+path+span+blob_hash+crux_text, где crux — текст, а не номера строк (идея graft, переживает рефакторинг). Без graft всё работает.",
  },
  {
    query: "почему картинка дёргается, хотя считать там почти нечего",
    doc: "viz/лэйаут: 300 итераций на 14 узлах стоят 166 мс не из-за счёта, а из-за setTimeout(step,0) между пачками. EMIT_EVERY=8 даёт 38 таймерных прыжков, Chrome прижимает вложенный setTimeout к ~4 мс: замер на n=2 (счёта нет вовсе) даёт те же 161.7 мс. В Bun, где клампа нет, тот же код на n=14 занимает 51 мс.",
  },
  {
    query: "чем опасно держать производное значение отдельным столбцом",
    doc: "Расхождения с источниками, принятые осознанно: дотовый ID myc-a3f8.1.2 — вычисляемый ярлык, не хранимое поле (у beads хранимый, но это безопасно только под cell-merge Dolt); добавлен 11-й тип ребра contradicts; MCP-профили 7/11/16 вместо 43 инструментов memora.",
  },
  {
    query: "где искать описание горячего пути и бюджетов",
    doc: "Источник истины по дизайну — docs/design/: 00-brief.md (бриф и бюджеты), 01-core-data-model.md (схема, DDL, оплог, ACL), 02-retrieval-and-performance.md (горячий путь, RRF, эмбеддинги), 03-interfaces-and-integration.md (CLI, MCP, хуки, proxy), 04-swarm-learning-and-routing.md (телеметрия и роутинг моделей).",
  },
  {
    query: "как складывать вместе истории изменений из разных копий",
    doc: "Отложенные операции репликации (ребро раньше концов, set раньше set(kind)) лежат в oplog_pending с id недостающего узла и применяются в той транзакции applyOps, где узел материализуется. У одного site_id seq и hlc растут вместе, поэтому последний seq сайта читается через запись с max(hlc) по ix_oplog_site.",
  },
  {
    query: "во что обходится поднять расширение базы на каждый запуск",
    doc: "S45: лёгкий драйвер CLI намеренно не поднимает рантайм расширений — show обязан укладываться в 3 мс, а загрузка vec0 стоит 4–7 мс на процесс. Решение: рантайм расширений грузится лениво и по потребности команды — recall, search, digest его поднимают, ready, claim, show, close нет.",
  },
];

export const EN_PAIRS: readonly SeparationPair[] = [
  {
    query: "does setting up a workspace reach out to the internet",
    doc: "Zero questions, zero network calls. Autodetects the git root and slug from the directory name; both are shown, never confirmed. Re-running on an existing workspace is a no-op (exit 0) unless --force is given. The embeddings model is not downloaded here — that's `myc models fetch`, and its absence never blocks task work.",
  },
  {
    query: "what exactly gets committed to version control",
    doc: "S42: only the oplog goes to git and it is merged by union on op_id (no text merge). Node/edge projections are a local cache in .myc/projections, rebuilt by `myc import` and never committed. Export never deletes or truncates oplog files; projection files left in .myc/graph by the old format are removed.",
  },
  {
    query: "is it safe to pull the same changes twice",
    doc: "Idempotent: only operations missing from the local oplog are applied, through the same CRDT path as sync (per-field LWW, add-wins edges, G-counters). The projection cache is a pure function of the merged log and is never committed, so nothing needs to be committed after an import.",
  },
  {
    query: "how fast is saving a new fact and what is deferred",
    doc: "Writes one memory node. The fact is the positional argument; '-' reads stdin. Everything expensive (embedding, absorb classification) is queued in jobs, never done on the write path: the write itself is a single transaction under 5 ms.",
  },
  {
    query: "how do I tell which parts of the lookup actually fired",
    doc: "Same engine as `myc search`, different UX (decision D6). Reads BOTH tiers through federatedSearch and marks the personal tier as `me`. The footer always names the retrieval branches that actually produced the output; degradation is a WARN line, and exit 6 under --strict.",
  },
  {
    query: "why is there a resident helper process for questions",
    doc: "Second half of decision S44. A cold ONNX warmup costs ~223 ms against a 25 ms recall budget, so the vector branch was off by default and paraphrased questions found nothing. This daemon pays the warmup once as an `embed_warm` job from the jobs queue and then answers query-vector requests over a unix socket.",
  },
  {
    query: "what arguments does the three-way merge helper receive",
    doc: "Arguments as git passes them: %O (base) %A (ours, rewritten in place) %B (theirs). Registering the driver once per clone is what makes the union merge of the operation log automatic.",
  },
  {
    query: "how does the table view differ from the conversational one",
    doc: "Same engine as `myc recall` (decision D6), different UX. Reads BOTH tiers through federatedSearch; the `tier` column marks where a hit came from. The footer names the retrieval branches that actually produced the output.",
  },
  {
    query: "why does a search sometimes skip the semantic step",
    doc: "The lightweight CLI driver deliberately does not raise the extension runtime: show has to fit in 3 ms while loading vec0 costs 4-7 ms per process. The runtime is raised lazily and only for the commands that need it, so the cost lands on a 25 ms budget rather than on a 3 ms one.",
  },
  {
    query: "what stops two different vector spaces from being mixed",
    doc: "The fingerprint of the vector space is written into myc_meta as backend:provider:model:dim:norm. A mismatch with the recorded value refuses the write: index corruption is not visible immediately but months later, so silently mixing spaces is forbidden by the architecture.",
  },
];

/** Бытовые тексты того же языка — контроль «далёкой» пары. */
export const RU_UNRELATED: readonly string[] = [
  "Рецепт борща: свёклу натереть на крупной тёрке, обжарить с томатной пастой, добавить в бульон за десять минут до готовности, подавать со сметаной и пампушками с чесноком.",
  "Щенку в возрасте восьми недель делают первую прививку от чумки и энтерита, вторую через три недели, а от бешенства — не раньше трёх месяцев.",
  "Билеты на утренний поезд до Вологды разбирают за неделю, поэтому в кассе на вокзале остаются только места в плацкарте у туалета.",
  "Тесто для блинов заводят на молоке комнатной температуры, дают постоять полчаса, а первый блин всегда уходит коту.",
  "Зимнюю резину меняют, когда среднесуточная температура держится ниже семи градусов, а не когда выпал первый снег.",
];

export const EN_UNRELATED: readonly string[] = [
  "For borscht, grate the beetroot coarsely, fry it with tomato paste, add it to the stock ten minutes before it is done, and serve with sour cream and garlic buns.",
  "A puppy gets its first distemper and parvovirus shot at eight weeks, the booster three weeks later, and the rabies shot no earlier than three months.",
  "Morning train tickets sell out about a week ahead, so the station counter usually only has the bunk next to the toilet left.",
  "Pancake batter is made with room-temperature milk, rested for half an hour, and the first pancake always goes to the cat.",
  "Winter tyres go on when the daily average stays below seven degrees, not when the first snow falls.",
];

export interface LanguageCorpus {
  readonly lang: "ru" | "en";
  readonly pairs: readonly SeparationPair[];
  readonly unrelated: readonly string[];
}

export const CORPORA: readonly LanguageCorpus[] = [
  { lang: "ru", pairs: RU_PAIRS, unrelated: RU_UNRELATED },
  { lang: "en", pairs: EN_PAIRS, unrelated: EN_UNRELATED },
];
