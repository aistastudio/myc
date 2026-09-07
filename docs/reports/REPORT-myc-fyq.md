# myc-fyq — absorb, детерминированная ступень A

## Что сделано

- `packages/core/src/absorb.ts` — чистый модуль классификации без LLM: нормализация
  (NFKC, пробелы, концевая пунктуация, lowercase) и sha256-хеш, символьные триграммы
  и жаккар, косинус, лексические сигналы (маркеры замены, переворот полярности над
  тем же словом, антонимы по основе, расхождение чисел, покрытие/рост текста),
  `classifyPair` / `classifyAbsorb`, `canonicalOf`, пороги и их разбор из секции
  `[absorb]` в `workspace.toml`. Экспортирован из `@myc/core`.
- `packages/cli/src/commands/absorb.ts` — воркер `myc absorb [<id>] [--limit] [--dry-run]
  [--no-embed] [--embed-timeout]`: разбирает `jobs(kind='absorb')`, берёт вектор из
  `nodes_vec` (или считает эмбеддером и кладёт туда, закрывая работу `embed`),
  кандидаты kNN top-24 + FTS top-24 того же kind в том же scope, применяет действия по
  классу через `GraphStore` (всё в оплог), пишет `attrs.absorb` в строку узла,
  `myc_health.absorb`, WARN и `meta.degraded[]`.
- `packages/cli/src/commands/remember.ts` — фаза 0 (§6.1): точный дубликат по
  `ux_nodes_content` не плодит узел, растит `seen_count`, очередь не ставится. Раньше
  повтор факта падал с `UNIQUE constraint failed`.
- `bench/absorb-pairs.json` (68 размеченных пар на реальных текстах воркспейса),
  `bench/absorb-calibrate.ts` (замер на настоящей модели + сетка порогов),
  `bench/absorb-calibration.json` (замороженный итог; тест сверяет с ним умолчания core).
- Тесты: `packages/core/src/absorb.test.ts` (25), `packages/cli/src/commands/absorb.test.ts` (14).

## Действия по классу

| Класс | Что происходит |
|---|---|
| duplicate | ребро `duplicates: dup → canonical` (путь сжат до головы), `canonical.seen_count++`, `dup.head_id=canonical`, `status='superseded'` там, где kind это допускает |
| update | ребро `supersedes: new → old`, `head_id=new` у old и у всей его цепочки, `touches`/`mentions` копируются на new |
| contradiction | ребро `contradicts: new → old` (одно, читается симметрично), `confidence` обоих × 0.7, оба узла живут |
| related | ребро `relates` с весом = косинус; остальные кандидаты пояса тоже получают `relates` (не больше `max_related`) |
| new | ничего |

Кандидаты — только того же kind: заметка не «дублирует» задачу.

## Пороги — из замера, не из спеки

Модель `multilingual-e5-small-q8`, 140 узлов рабочего воркспейса, 68 пар. Распределение
косинуса f32 по меткам:

| метка | cos min…median…max | jac min…median…max |
|---|---|---|
| duplicate | 0.975…0.995…1.000 | 0.70…0.98…1.00 |
| update | 0.959…0.982…0.992 | 0.49…0.67…0.90 |
| contradiction | 0.924…0.973…0.992 | 0.29…0.53…0.96 |
| related | 0.839…0.861…0.920 | 0.06…0.14…0.22 |
| new | 0.765…0.819…0.855 | 0.03…0.07…0.12 |

Выводы замера: duplicate/update/contradiction по косинусу неразделимы (все в 0.96–0.99),
их разводят лексические признаки, а не порог; граница related/new лежит около 0.845 и
размыта (перекрытие 0.839–0.855 — это и есть разделение ~0.06 у модели); порог спеки
0.82 отправил бы в кандидаты почти все new, порог 0.95 — все update и contradiction в
duplicate. Ошибка квантизации int8 против f32: mean 0.00007, max 0.0003 — int8 из
`nodes_vec` годится для сравнения.

Выбранные пороги (целевая функция лексикографическая: ложные duplicate → ложные update →
macro-F1 → accuracy; при равенстве — консервативнее для duplicate):

```
dup_cos 0.99   dup_jac 0.7   cand_cos 0.845   cand_jac 0.2
dup_jac_noembed 0.9   cand_jac_noembed 0.2   max_related 3
```

Плато (значения с тем же качеством при прочих фиксированных): dup_cos 0.90…0.99,
dup_jac 0.5…0.7, cand_jac 0.2…0.6, cand_cos — одна точка 0.845 (знаковый край данных;
ошибка на нём симметричная и безобидная: лишнее или недостающее ребро relates).

## Матрица ошибок (с векторами), строки — метка, столбцы — вердикт

| | duplicate | update | contradiction | related | new |
|---|---|---|---|---|---|
| duplicate (14) | **14** | 0 | 0 | 0 | 0 |
| update (13) | 0 | **13** | 0 | 0 | 0 |
| contradiction (13) | 0 | 0 | **13** | 0 | 0 |
| related (14) | 0 | 0 | 0 | **12** | 2 |
| new (14) | 0 | 0 | 0 | 2 | **12** |

accuracy 94.1 %, macro-F1 0.943. **Ложных duplicate 0 из 54 не-дубликатов (0 %)**,
ложных update 0. Все 4 ошибки — related↔new.

Матрица без векторов (деградация): duplicate 11/14 (3 → related), update 0/13 и
contradiction 0/13 — все 26 стали related, new 14/14; ложных duplicate 0, ложных update 0.
То есть без эмбеддингов ничего не сливается и не выбрасывается — только не уточняется.

## Бюджет записи

`myc remember` через `run()` во временном воркспейсе, 400 замеров после 30 прогрева:

| путь | p50 | p95 | p99 | max |
|---|---|---|---|---|
| новый факт (createNode + очередь) | 1.00 мс | 1.80 | 2.90 | 11.5 |
| фаза 0, точный дубликат (индекс + seen_count++) | 0.50 мс | 1.00 | 1.90 | 15.6 |

Сама классификация (`myc absorb`) — фон: ~30 мс на узел с готовыми векторами,
~500 мс при первом подъёме ONNX в процессе.

## Громкая деградация

Без vec0 / без модели / с `--no-embed`: вердикт `quality='lexical'`, в строке узла
`attrs.absorb.quality='lexical'`, `attrs.absorb.degraded='<причина>'`, `attrs.degraded_at`;
`myc_health.absorb = degraded` с причиной; в конверте `warn[degraded.embed]` и
`meta.degraded[]`. После восстановления `myc_health.absorb` возвращается в `ok`.

## Проверки

`bun test` — 1094 pass, 0 fail (80 файлов); `bun run typecheck` — 0; `bun run
scripts/deps-check.ts` — passed for 12 packages.

## Не сделано / для следующих задач

- Показ пары `contradicts` вместе с пометкой в выдаче — сторона ретривала (myc-ua0);
  здесь только ребро и `confidence`.
- Без vec0 кандидаты не эмбеддятся на лету (можно было бы, ~25 мс на кандидата в фоне);
  сейчас без vec0 режим лексический, громко.
- Ступень B (LLM, myc-thb) должна брать пары из пояса `related` с `cos ≥ 0.92` —
  по замеру именно там лежат нераспознанные лексикой update/contradiction.
