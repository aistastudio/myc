// СГЕНЕРИРОВАНО site/build.ts — не править руками.
// Источник: site/measurements.json, сверено с артефактами репозитория.
window.MYC_DATA = {
  "_": "Единственный источник чисел для сайта. Каждая запись обязана нести command — команду, которой число повторяют. Записи с полем check сверяются с артефактами репозитория скриптом site/build.ts: расхождение — ошибка сборки, а не предупреждение. Правка руками без пересъёма — жульничество; сначала прогоните команду.",
  "env": {
    "date": "2026-09-07",
    "machine": "darwin-arm64-14",
    "bun": "1.3.14",
    "myc": "0.1.1",
    "beads": "1.0.5",
    "note_en": "The cache and the beads import were measured on this machine on this date with this myc, and have not been re-measured since; every entry measured later carries its own date — latency was re-measured on 2026-09-11 with myc 0.3.6.",
    "note_ru": "Кеш и импорт из beads сняты на этой машине в этот день на этой версии myc и с тех пор не переснимались; у каждой записи, снятой позже, стоит своя дата — задержки пересняты 2026-09-11 на myc 0.3.6."
  },
  "latency": {
    "command": "bun run scripts/bench-latency.ts",
    "_env": "Задержки пересняты отдельно от остальных чисел; их условия здесь, а env сверху — для остального.",
    "env": {
      "date": "2026-09-11",
      "machine": "darwin-arm64-14",
      "bun": "1.3.14",
      "myc": "0.3.6"
    },
    "corpus_en": "100 000 nodes, 5 trials x (warmup 20, 150 iterations)",
    "corpus_ru": "100 000 узлов, 5 трейлов x (прогрев 20, 150 итераций)",
    "check": {
      "file": "bench/baseline.json",
      "section": "darwin-arm64-14",
      "field": "p95",
      "tolerance": 0.15
    },
    "rows": [
      {
        "op": "prime",
        "label_en": "prime (session context packet)",
        "label_ru": "prime (пакет контекста сессии)",
        "p50": 0.509,
        "p95": 0.537,
        "p99": 0.608,
        "budget": 30,
        "n": 750
      },
      {
        "op": "read",
        "label_en": "read one node",
        "label_ru": "чтение узла",
        "p50": 0.004,
        "p95": 0.005,
        "p99": 0.01,
        "budget": 3,
        "n": 750
      },
      {
        "op": "search",
        "label_en": "hybrid search",
        "label_ru": "гибридный поиск",
        "p50": 6.648,
        "p95": 7.366,
        "p99": 8.215,
        "budget": 25,
        "n": 750
      },
      {
        "op": "write",
        "label_en": "write",
        "label_ru": "запись",
        "p50": 0.201,
        "p95": 0.288,
        "p99": 0.327,
        "budget": 5,
        "n": 300
      },
      {
        "op": "cold_start",
        "label_en": "cold start of the binary",
        "label_ru": "холодный старт бинаря",
        "p50": 18.68,
        "p95": 19.796,
        "p99": 21.337,
        "budget": 60,
        "n": 25
      }
    ]
  },
  "boost": {
    "command": "bun run bench/boost-eval.ts",
    "date": "2026-09-10",
    "check": {
      "file": "bench/boost-eval.json"
    },
    "corpus": {
      "nodes": 75,
      "queries": 25,
      "limit": 10,
      "vector": "never"
    },
    "overall": {
      "off": {
        "mrr": 0.52,
        "p1": 0.2
      },
      "on": {
        "mrr": 0.867,
        "p1": 0.8
      }
    },
    "groups": [
      {
        "key": "freshness",
        "label_en": "freshness",
        "label_ru": "свежесть",
        "off": 0.4,
        "on": 1
      },
      {
        "key": "priority",
        "label_en": "priority",
        "label_ru": "приоритет",
        "off": 0.4,
        "on": 1
      },
      {
        "key": "layer_prime",
        "label_en": "layer: prime",
        "label_ru": "ярус: prime",
        "off": 0.8,
        "on": 1
      },
      {
        "key": "layer_deep",
        "label_en": "layer: deep",
        "label_ru": "ярус: deep",
        "off": 0.4,
        "on": 1
      },
      {
        "key": "distractor",
        "label_en": "distractor (control)",
        "label_ru": "дистрактор (контроль)",
        "off": 0.6,
        "on": 0.333,
        "control": true
      }
    ]
  },
  "graph": {
    "command": "bun run bench/graph-eval.ts",
    "date": "2026-09-10",
    "check": {
      "file": "bench/graph-eval.json"
    },
    "corpus": {
      "nodes": 105,
      "edges": 60,
      "queries": 25,
      "limit": 10,
      "vector": "never"
    },
    "overall": {
      "off": {
        "mrr": 0.193,
        "p1": 0.08,
        "found": 10
      },
      "hop1": {
        "mrr": 0.355,
        "p1": 0.08,
        "found": 20
      },
      "hop2": {
        "mrr": 0.422,
        "p1": 0.08,
        "found": 25
      }
    },
    "total_queries": 25,
    "groups": [
      {
        "key": "hop1",
        "label_en": "answer one hop away",
        "label_ru": "ответ в одном хопе",
        "off": 0,
        "hop1": 0.5,
        "hop2": 0.5
      },
      {
        "key": "hop2",
        "label_en": "answer two hops away",
        "label_ru": "ответ в двух хопах",
        "off": 0,
        "hop1": 0,
        "hop2": 0.333
      },
      {
        "key": "typed",
        "label_en": "typed edge",
        "label_ru": "типизированное ребро",
        "off": 0,
        "hop1": 0.5,
        "hop2": 0.5
      },
      {
        "key": "lexical",
        "label_en": "lexical (untouched)",
        "label_ru": "лексический (не тронут)",
        "off": 0.633,
        "hop1": 0.633,
        "hop2": 0.633
      },
      {
        "key": "distractor",
        "label_en": "distractor (control)",
        "label_ru": "дистрактор (контроль)",
        "off": 0.333,
        "hop1": 0.143,
        "hop2": 0.143,
        "control": true
      }
    ],
    "cache": {
      "hits": 25,
      "misses": 25,
      "rank_mismatches": 0,
      "keys_distinct": true
    }
  },
  "cache": {
    "command": "bun test packages/retrieval/src/cache.test.ts packages/embed/src/cache.test.ts",
    "tests": {
      "pass": 53,
      "fail": 0
    },
    "rows": [
      {
        "key": "search",
        "label_en": "hybrid search, 2000-node corpus",
        "label_ru": "гибридный поиск, корпус 2000 узлов",
        "miss_ms": 1.682,
        "hit_ms": 0.0067,
        "ratio": 252
      },
      {
        "key": "embed",
        "label_en": "query embedding (WASM)",
        "label_ru": "эмбеддинг запроса (WASM)",
        "miss_ms": 23.3,
        "hit_ms": 0.0009,
        "ratio": 27044
      }
    ],
    "hitrate": [
      {
        "key": "quiet",
        "label_en": "60 queries, no writes",
        "label_ru": "60 запросов, без записей",
        "hits": 40,
        "of": 60
      },
      {
        "key": "writes",
        "label_en": "60 queries, a write every 20",
        "label_ru": "60 запросов, запись каждые 20",
        "hits": 24,
        "of": 60
      }
    ],
    "memory": {
      "search_mib": 0.81,
      "embed_mib": 1.46,
      "search_entries": 512,
      "embed_entries": 1000
    },
    "ranking_note_command": "bun run bench/graph-eval.ts"
  },
  "import": {
    "command": "myc import-beads <snapshot.json>",
    "prep_command": "cd <beads-project> && bd export --include-memories > snapshot.json",
    "target_en": "a live project (cherry), imported into an empty myc workspace",
    "target_ru": "живой проект (cherry), ввезённый в пустой воркспейс myc",
    "ms": 889,
    "rows": [
      {
        "key": "tasks",
        "label_en": "tasks",
        "label_ru": "задачи",
        "n": 796
      },
      {
        "key": "edges",
        "label_en": "dependencies",
        "label_ru": "зависимости",
        "n": 972
      },
      {
        "key": "notes",
        "label_en": "notes",
        "label_ru": "заметки",
        "n": 265
      },
      {
        "key": "memories",
        "label_en": "memories",
        "label_ru": "память",
        "n": 41
      }
    ],
    "warnings": [
      {
        "en": "2 issue types myc does not know (chore) carried over verbatim into attrs.type",
        "ru": "2 типа задач, которых myc не знает (chore), ввезены дословно в attrs.type"
      },
      {
        "en": "1 priority clamped to the myc scale (cherry-qnf: P4 -> P3)",
        "ru": "1 приоритет прижат к шкале myc (cherry-qnf: P4 → P3)"
      }
    ],
    "ready_gap": {
      "date": "2026-09-09",
      "myc": 152,
      "bd": 152,
      "diff": 0,
      "myc_command": "myc ready --json",
      "bd_command": "bd ready",
      "issue": "memory-atcm254ry6c7",
      "issue_closed": "memory-atcm254ry6c7",
      "note_en": "Measured again on 2026-09-09 after the fix: both queues return 152. Before it, myc offered 195 against beads' 144 — 51 tasks inside a still-blocked epic, which beads was right to hide. myc now materialises anc_blockers and says so: 281 blocked (51 through an ancestor).",
      "note_ru": "Перемерено 2026-09-09 после исправления: обе очереди дают 152. До него myc предлагал 195 против 144 у beads — 51 задача внутри ещё заблокированного эпика, и beads был прав, что их прятал. Теперь myc материализует anc_blockers и говорит об этом: 281 заблокировано (51 через предка)."
    }
  },
  "package": {
    "command": "bun run pack:npm",
    "compressed_mb": 3.39,
    "unpacked_mb": 12.49,
    "files": 13,
    "install_command": "bun install -g @aistastudio/myc",
    "model": {
      "command": "myc models fetch multilingual-e5-small-q8",
      "mb": 129.1,
      "seconds": 7.3,
      "source": "docs/reports/REPORT-npm-package.md",
      "measured_here": false
    },
    "version": "0.3.6",
    "date": "2026-09-11"
  },
  "roadmap": {
    "command": "bun run site/roadmap.ts",
    "as_of": "2026-09-11",
    "source": "myc 0.3.6 (schema 1) · 13 epics of this repository's workspace",
    "rows": [
      {
        "id": "memory-5xravkn0anzk",
        "key": "M0",
        "title_en": "core and tasks",
        "title_ru": "ядро и задачи",
        "status": "open",
        "done": 40,
        "total": 43,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-e7gn61sp2mfp",
            "status": "open",
            "priority": 0,
            "title": "Приёмка M0: myc заменяет beads в реальном проекте"
          },
          {
            "id": "memory-tatk1jg3qjfs",
            "status": "open",
            "priority": 2,
            "title": "Хук post-edit платит за граф модулей дренажа на каждую правку агента"
          },
          {
            "id": "memory-vt0rkpv0xwn2",
            "status": "open",
            "priority": 2,
            "title": "Справедливость очереди ready между агентами"
          }
        ]
      },
      {
        "id": "memory-ancs66k238nv",
        "key": "M0.5",
        "title_en": "self-hosting: myc developed through myc",
        "title_ru": "самохостинг: myc разрабатывается через myc",
        "status": "closed",
        "done": 4,
        "total": 4,
        "cancelled": 0,
        "in_progress": 0,
        "open": []
      },
      {
        "id": "memory-kh9wpqkwj1dm",
        "key": "M1",
        "title_en": "memory",
        "title_ru": "память",
        "status": "open",
        "done": 22,
        "total": 24,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-da4pb1ws4zhk",
            "status": "open",
            "priority": 2,
            "title": "Ретеншн L0, decay, prune и purge"
          },
          {
            "id": "memory-kj05ajqrrq3x",
            "status": "open",
            "priority": 3,
            "title": "score_rel — публичный контракт: нужна заметка о миграции"
          }
        ]
      },
      {
        "id": "memory-vtvz9sdjekgx",
        "key": "M2",
        "title_en": "semantics",
        "title_ru": "семантика",
        "status": "open",
        "done": 20,
        "total": 22,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-q036cwa85b04",
            "status": "open",
            "priority": 2,
            "title": "myc digest — пакет знаний по теме"
          },
          {
            "id": "memory-wfgj2r5j39qv",
            "status": "open",
            "priority": 2,
            "title": "Смягчить расхождение отпечатка по полю бэкенда"
          }
        ]
      },
      {
        "id": "memory-cmg64b6vrw0b",
        "key": "M7",
        "title_en": "human interface: board, cards, threads",
        "title_ru": "человек в интерфейсе: доска, карточки, нити",
        "status": "closed",
        "done": 15,
        "total": 15,
        "cancelled": 0,
        "in_progress": 0,
        "open": []
      },
      {
        "id": "memory-4ez67f48fcdv",
        "key": "M3",
        "title_en": "code intelligence: anchors code <-> knowledge",
        "title_ru": "код: якоря код ↔ знание",
        "status": "open",
        "done": 7,
        "total": 10,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-apq1h7wra93w",
            "status": "open",
            "priority": 1,
            "title": "Приёмка M3: связь код ↔ знание в обе стороны"
          },
          {
            "id": "memory-5c03r9t5n472",
            "status": "open",
            "priority": 2,
            "title": "Ре-привязка якорей после рефакторинга"
          },
          {
            "id": "memory-g79mpkt53yn3",
            "status": "open",
            "priority": 2,
            "title": "Фоновый расчёт fan_in символа"
          }
        ]
      },
      {
        "id": "memory-x20k85amw3z9",
        "key": "graft",
        "title_en": "replacing graft: built-in code intelligence on tree-sitter",
        "title_ru": "замена graft: свой код-интеллект на tree-sitter",
        "status": "closed",
        "parent": "memory-4ez67f48fcdv",
        "done": 6,
        "total": 7,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-eyqdv56a95s5",
            "status": "open",
            "priority": 2,
            "title": "Пул разбора перестал окупаться на tree-sitter: замерить и перенастроить размер"
          }
        ]
      },
      {
        "id": "memory-rc2s0m1e9kpz",
        "key": "EN",
        "title_en": "all CLI and MCP output in English",
        "title_ru": "весь вывод CLI и MCP — на английском",
        "status": "closed",
        "done": 2,
        "total": 2,
        "cancelled": 0,
        "in_progress": 0,
        "open": []
      },
      {
        "id": "memory-14qyv1gmacef",
        "key": "queue",
        "title_en": "a machine-wide queue for heavy commands",
        "title_ru": "очередь тяжёлых команд на машине",
        "status": "open",
        "done": 3,
        "total": 5,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-n2tcwbwcwxzb",
            "status": "open",
            "priority": 2,
            "title": "Сегмент очереди в строке статуса: сколько ждут и сколько я уже жду"
          },
          {
            "id": "memory-40r75txge0fb",
            "status": "open",
            "priority": 3,
            "title": "Число слотов и полосы — конфигом ~/.myc/queue.toml [lanes.heavy] slots, умолчание по ядрам"
          }
        ]
      },
      {
        "id": "memory-aw5d21x3wa87",
        "key": "M4",
        "title_en": "team: myc serve, ACL, network sync, Postgres",
        "title_ru": "команда: myc serve, ACL, сетевая синхронизация, Postgres",
        "status": "open",
        "done": 3,
        "total": 14,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-0sbdhdt7fm36",
            "status": "open",
            "priority": 1,
            "title": "myc sync и разрешение конфликтов"
          },
          {
            "id": "memory-2xgh8mg2fs24",
            "status": "open",
            "priority": 1,
            "title": "Postgres DDL и pgvector HNSW halfvec"
          },
          {
            "id": "memory-bjy6fq9kxj47",
            "status": "open",
            "priority": 1,
            "title": "myc serve: HTTP API, Bearer, мульти-воркспейс"
          },
          {
            "id": "memory-czm24d25q295",
            "status": "open",
            "priority": 1,
            "title": "Приёмка M4: команда на общей базе"
          },
          {
            "id": "memory-dastrwgyzty9",
            "status": "open",
            "priority": 1,
            "title": "Сетевая синхронизация поверх готового обмена оплогом"
          },
          {
            "id": "memory-w0r3vhgkxmsw",
            "status": "open",
            "priority": 1,
            "title": "ACL: четыре уровня, фильтр до ранжирования"
          },
          {
            "id": "memory-3n0svbkbjaew",
            "status": "open",
            "priority": 2,
            "title": "Контейнеры и compose-топология"
          },
          {
            "id": "memory-gpknypxyk91j",
            "status": "open",
            "priority": 2,
            "title": "Веб-визуализация графа"
          },
          {
            "id": "memory-krn44m79r4dr",
            "status": "open",
            "priority": 2,
            "title": "SSE-дельты с Last-Event-ID по oplog.seq"
          },
          {
            "id": "memory-s8zk9v8h5rp0",
            "status": "open",
            "priority": 2,
            "title": "MCP-профили leader и full"
          },
          {
            "id": "memory-zzz7w3c8dc6x",
            "status": "open",
            "priority": 2,
            "title": "Миграция SQLite в Postgres"
          }
        ]
      },
      {
        "id": "memory-0dm3hdvdmr5c",
        "key": "M5",
        "title_en": "swarm self-learning: routing by cost and outcome",
        "title_ru": "самообучение роя: роутинг по цене и результату",
        "status": "open",
        "done": 0,
        "total": 13,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-0adbcy3rhqj4",
            "status": "open",
            "priority": 2,
            "title": "Приёмка M5: роутинг доказуемо экономит"
          },
          {
            "id": "memory-0wfmcf2kgbvb",
            "status": "open",
            "priority": 2,
            "title": "Отпечаток задачи: 28 классов intent × scope"
          },
          {
            "id": "memory-76byppzy2a2k",
            "status": "open",
            "priority": 2,
            "title": "myc route, myc report models и MCP-инструмент"
          },
          {
            "id": "memory-91apr1tp1qzw",
            "status": "open",
            "priority": 2,
            "title": "Честная оценка: пропенсити, IPS/SNIPS/DR и контроль"
          },
          {
            "id": "memory-ch6qen5t9rbe",
            "status": "open",
            "priority": 2,
            "title": "Сигналы исхода, атрибуция и отложенные события"
          },
          {
            "id": "memory-d64pv4dw3m1j",
            "status": "open",
            "priority": 2,
            "title": "Общий пул статистики агентов: какие агенты лучше для каких задач — от метки исхода к публичному пулу и монетизации"
          },
          {
            "id": "memory-fxazm220dtsq",
            "status": "open",
            "priority": 2,
            "title": "Таблицы swarm_attempt, swarm_signal, swarm_route_decision, приоры"
          },
          {
            "id": "memory-qe0dtdf1h3rz",
            "status": "open",
            "priority": 2,
            "title": "Модель стоимости и функция полезности"
          },
          {
            "id": "memory-y1k58t110cdq",
            "status": "open",
            "priority": 2,
            "title": "Жизненный цикл попытки и git-трейлеры"
          },
          {
            "id": "memory-z7k5x3bppvr0",
            "status": "open",
            "priority": 2,
            "title": "Томпсон-семплинг и иерархические приоры"
          },
          {
            "id": "memory-zga00epa0rky",
            "status": "open",
            "priority": 2,
            "title": "Приватность приоров и валидатор на сервере"
          },
          {
            "id": "memory-ast410zxvdpd",
            "status": "open",
            "priority": 3,
            "title": "Забывание и детектор смены режима"
          },
          {
            "id": "memory-xjzvw9fyxkz0",
            "status": "open",
            "priority": 3,
            "title": "Каскад и формула порога эскалации"
          }
        ]
      },
      {
        "id": "memory-d64pv4dw3m1j",
        "key": "pool",
        "title_en": "a shared pool of agent statistics",
        "title_ru": "общий пул статистики агентов",
        "status": "open",
        "parent": "memory-0dm3hdvdmr5c",
        "done": 0,
        "total": 4,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-gxbf5h1kwya6",
            "status": "open",
            "priority": 2,
            "title": "Польза одному пользователю: разница между моделями видна на данных одного репозитория (критерий остановки общего пула)"
          },
          {
            "id": "memory-rsje5wn1w75r",
            "status": "open",
            "priority": 2,
            "title": "Метка исхода с разбросом: попытки пишутся сами, в них оркестратор и судья; доработки, правки координатора и перекрёстный вердикт — сигналы"
          },
          {
            "id": "memory-x80d134ygdwy",
            "status": "open",
            "priority": 2,
            "title": "Пул команды (§2.7): закрытый пул организации — первая платная функция, оркестратор и судья — измерения на сервере"
          },
          {
            "id": "memory-7n2h02wm1eer",
            "status": "open",
            "priority": 3,
            "title": "Публичный пул по согласию: give-to-get, превью отправки, k-анонимность ячеек, защита от накрутки; затем платные тарифы"
          }
        ]
      },
      {
        "id": "memory-6dzxkzwbsc9g",
        "key": "M6",
        "title_en": "distillation",
        "title_ru": "дистилляция",
        "status": "open",
        "done": 0,
        "total": 7,
        "cancelled": 0,
        "in_progress": 0,
        "open": [
          {
            "id": "memory-3akx1aywngt6",
            "status": "open",
            "priority": 3,
            "title": "Proxy-режим, выключенный по умолчанию"
          },
          {
            "id": "memory-44rwc3hw1h7g",
            "status": "open",
            "priority": 3,
            "title": "absorb, ступень B на LLM"
          },
          {
            "id": "memory-7mgcnf2z2eeh",
            "status": "open",
            "priority": 3,
            "title": "skills как поверхность"
          },
          {
            "id": "memory-b990rs205an8",
            "status": "open",
            "priority": 3,
            "title": "Абстракция LLM-провайдеров"
          },
          {
            "id": "memory-dpbjv4e8wz2m",
            "status": "open",
            "priority": 3,
            "title": "Приёмка M6: контекст проекта собирается сам"
          },
          {
            "id": "memory-ez3a7gpgccce",
            "status": "open",
            "priority": 3,
            "title": "Дистиллятор L0 → L1: извлечение атомов"
          },
          {
            "id": "memory-jqgga8mrgbzm",
            "status": "open",
            "priority": 3,
            "title": "Подъём L1 → L2 → L3"
          }
        ]
      }
    ]
  },
  "features": {
    "command": "myc --help",
    "groups": [
      {
        "key": "tasks",
        "title_en": "Tasks",
        "title_ru": "Задачи",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc task \"…\" --parent <epic> --dep <id>",
            "en": "Tasks, bugs and epics in one graph: a parent hierarchy, dependencies, priorities, tags and estimates.",
            "ru": "Задачи, баги и эпики в одном графе: иерархия parent, зависимости, приоритеты, теги и оценки."
          },
          {
            "since": "0.1.0",
            "cmd": "myc ready --why",
            "en": "A ready queue: open tasks with no open blockers, ranked; <code>--why</code> prints every term of the score.",
            "ru": "Очередь готовых задач: открытые и без открытых блокеров, ранжированные; <code>--why</code> печатает каждое слагаемое оценки."
          },
          {
            "since": "0.1.0",
            "cmd": "myc ready --claim",
            "en": "Taking work is atomic: a claim is a compare-and-swap lease, so two agents never get the same task; <code>release</code> gives it back, <code>close</code> finishes it.",
            "ru": "Взять работу — атомарно: claim — это аренда через compare-and-swap, и два агента одну задачу не получат; <code>release</code> возвращает её, <code>close</code> закрывает."
          },
          {
            "since": "0.2.0",
            "cmd": "myc ready",
            "en": "Blockers are inherited down the parent chain: a task inside a blocked epic is not offered, and the queue says how many it withheld — <code>281 blocked (51 through an ancestor)</code>.",
            "ru": "Блокеры наследуются вниз по цепочке parent: задачу внутри заблокированного эпика очередь не предлагает и говорит, сколько скрыла, — <code>281 blocked (51 through an ancestor)</code>."
          },
          {
            "since": "0.1.0",
            "cmd": "myc dep why <id>",
            "en": "Why a task is blocked, and what it blocks: <code>dep why</code> and <code>dep tree</code>.",
            "ru": "Почему задача заблокирована и что блокирует она сама: <code>dep why</code> и <code>dep tree</code>."
          },
          {
            "since": "0.2.0",
            "cmd": "myc comment <id> \"…\"",
            "en": "Comments are one thread per node, joined by a <code>replies_to</code> edge, whichever surface wrote them — CLI, MCP or the web UI.",
            "ru": "Комментарии — одна нить у узла, связанная ребром <code>replies_to</code>, какой бы поверхностью они ни были написаны: CLI, MCP или веб-интерфейсом."
          },
          {
            "since": "0.3.0",
            "cmd": "myc link <a> supersedes <b> --reason \"…\"",
            "en": "Typed links from the terminal, answering word for word like the MCP tool <code>myc_link</code>: a contradiction in memory is resolved by a link, not by overwriting.",
            "ru": "Типизированные связи из терминала — с тем же ответом слово в слово, что у MCP-инструмента <code>myc_link</code>: противоречие в памяти разрешается связью, а не перезаписью."
          },
          {
            "since": "0.3.4",
            "cmd": "myc show <id>",
            "en": "A lease is shown as it is — <code>no lease</code>, <code>until … (in 25m)</code>, <code>lease expired 3h ago</code> — and <code>prime</code> counts every task in progress.",
            "ru": "Аренда показана как есть — <code>no lease</code>, <code>until … (in 25m)</code>, <code>lease expired 3h ago</code>, — и <code>prime</code> считает каждую задачу в работе."
          },
          {
            "since": "0.1.0",
            "cmd": "myc move <id> --to <dir>",
            "en": "Move a task to another workspace, keeping its id and its oplog.",
            "ru": "Перенести задачу в другой воркспейс, сохранив её id и оплог."
          },
          {
            "since": "0.1.0",
            "cmd": "myc attempt list",
            "en": "Attempts: who took a task, with which model, and how it ended.",
            "ru": "Попытки: кто взял задачу, какой моделью и чем это кончилось."
          },
          {
            "since": "0.2.0",
            "cmd": "myc attempt list --live",
            "en": "Run memory: the session, process and git head of each attempt, each with where it was obtained from; <code>--live</code> tells a working agent from an orphan.",
            "ru": "Память запусков: сессия, процесс и git head каждой попытки — и откуда взято каждое; <code>--live</code> отличает работающего агента от сироты."
          },
          {
            "since": "0.1.0",
            "cmd": "myc report models",
            "en": "A model roster with dated prices, and a report of which model is cheaper at an equal result per task class — the data routing would learn from. Routing itself is not built (M5).",
            "ru": "Ростер моделей с датированными ценами и отчёт, какая модель дешевле при равном результате по классу задач, — данные, на которых учился бы роутинг. Самого роутинга нет (M5)."
          }
        ]
      },
      {
        "key": "memory",
        "title_en": "Memory and compaction",
        "title_ru": "Память и сжатие",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc remember \"why X, not Y\"",
            "en": "Facts and decisions are nodes next to tasks, in layers L0–L3; the project tier lives in the repository, the personal tier in <code>~/.myc</code> (<code>--global</code>).",
            "ru": "Факты и решения — узлы рядом с задачами, по ярусам L0–L3; проектный слой живёт в репозитории, личный — в <code>~/.myc</code> (<code>--global</code>)."
          },
          {
            "since": "0.1.0",
            "cmd": "myc prime",
            "en": "A session context packet under a character budget: ready work, work in progress, core knowledge and decisions — and a count of what did not fit.",
            "ru": "Пакет контекста сессии в бюджете символов: готовая работа, работа в процессе, ядро знаний и решения — и счёт того, что не вошло."
          },
          {
            "since": "0.1.0",
            "cmd": "myc bootstrap set <key> \"<text>\"",
            "en": "Pinned start-of-session rules that survive compaction: the auto-detected part is recomputed, the manual part stays as written.",
            "ru": "Закреплённые правила начала сессии, которые переживают сжатие: автоматическая часть пересчитывается, ручная остаётся как написана."
          },
          {
            "since": "0.1.0",
            "cmd": "myc absorb-session --reason manual",
            "en": "Before the context is compacted, the session episode is written to disk first — raw, L0, private, secrets masked — and only then a rescue packet is printed back into the context.",
            "ru": "Перед сжатием контекста эпизод сессии сначала ложится на диск — сырым, L0, приватным, с замаскированными секретами, — и только потом в контекст печатается спасательный пакет."
          },
          {
            "since": "0.1.0",
            "cmd": "myc recall \"…\" --session s1",
            "en": "Notes carry a session reach: <code>prime</code> brings only this session's notes; <code>recall</code> still finds the others and marks them <code>ses*</code>.",
            "ru": "У заметок есть охват сессии: <code>prime</code> приносит только заметки этой сессии, <code>recall</code> находит и чужие, помечая их <code>ses*</code>."
          },
          {
            "since": "0.1.0",
            "cmd": "myc prime --repo all",
            "en": "…and a repository reach: in a workspace of several repositories, the other repositories' notes are hidden from <code>prime</code> and counted, not dropped.",
            "ru": "…и охват репозитория: в воркспейсе из нескольких репозиториев заметки остальных скрыты из <code>prime</code> и посчитаны, а не выброшены."
          },
          {
            "since": "0.1.0",
            "cmd": "myc absorb --dry-run",
            "en": "New memory is classified without a model — duplicate, update, contradiction, related, new — by hash, cosine and trigrams, with thresholds calibrated on labelled pairs.",
            "ru": "Новая память классифицируется без модели — дубль, обновление, противоречие, связанное, новое — по хешу, косинусу и триграммам, с порогами, откалиброванными на размеченных парах."
          }
        ]
      },
      {
        "key": "search",
        "title_en": "Search and ranking",
        "title_ru": "Поиск и ранжирование",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc search \"…\" --mode hybrid",
            "en": "Hybrid search: BM25 and vectors fused by RRF, then boosted by priority, freshness and layer — measured in the Ranking section below.",
            "ru": "Гибридный поиск: BM25 и векторы, слитые RRF, затем бусты по приоритету, свежести и ярусу — замер в разделе «Ранжирование» ниже."
          },
          {
            "since": "0.1.0",
            "cmd": "myc recall \"…\" --why",
            "en": "Graph expansion to two hops reaches answers that share no words with the question; <code>--why</code> says which branch took part and why.",
            "ru": "Обход графа на два хопа достаёт ответы, не совпадающие с вопросом ни словом; <code>--why</code> говорит, какая ветка участвовала и почему."
          },
          {
            "since": "0.1.0",
            "cmd": "myc models fetch multilingual-e5-small-q8",
            "en": "Semantic search is opt-in: the model is downloaded only by this command and checked by sha256; until then search is lexical and says so on every answer.",
            "ru": "Семантический поиск — по запросу: модель качается только этой командой и сверяется по sha256; до тех пор поиск лексический и говорит об этом в каждом ответе."
          },
          {
            "since": "0.1.0",
            "cmd": "myc reindex",
            "en": "Vectors are built by a background job queue — batches, checkpoints, a content-hash skip — and a warm embedder serves queries over a socket (<code>myc embedd</code>).",
            "ru": "Векторы строит фоновая очередь заданий — пачками, с контрольными точками и пропуском по хешу содержимого, — а тёплый эмбеддер отдаёт векторы запросов через сокет (<code>myc embedd</code>)."
          },
          {
            "since": "0.1.0",
            "cmd": "myc recall \"…\" --strict",
            "en": "Degradation is loud: a lexical-only answer carries <code>WARN degraded.embeddings</code>, and <code>--strict</code> turns any degradation into a non-zero exit code.",
            "ru": "Деградация громкая: чисто лексический ответ несёт <code>WARN degraded.embeddings</code>, а <code>--strict</code> превращает любую деградацию в ненулевой код выхода."
          },
          {
            "since": "0.1.0",
            "cmd": "bun test packages/retrieval/src/cache.test.ts",
            "en": "Result, embedding and hydration caches are invalidated by <code>MAX(oplog.seq)</code> read from the database, so another process's write drops them too.",
            "ru": "Кеши результатов, эмбеддингов и гидратации инвалидируются по <code>MAX(oplog.seq)</code> из базы, поэтому их сбрасывает и запись чужого процесса."
          }
        ]
      },
      {
        "key": "code",
        "title_en": "Code",
        "title_ru": "Код",
        "items": [
          {
            "since": "0.3.0",
            "cmd": "myc code index",
            "en": "A built-in code index on tree-sitter: symbols for TypeScript, TSX, JavaScript and Python, every other file registered by path and hash; a repeat run reparses nothing.",
            "ru": "Встроенный индекс кода на tree-sitter: символы для TypeScript, TSX, JavaScript и Python, остальные файлы — по пути и хешу; повторный прогон ничего не разбирает заново."
          },
          {
            "since": "0.3.0",
            "cmd": "myc code fetch",
            "en": "Grammars are fetched on demand and checked by sha256; indexing itself never goes to the network, and a language without its grammar is skipped and named.",
            "ru": "Грамматики качаются по требованию и сверяются по sha256; сама индексация в сеть не ходит никогда, а язык без грамматики пропускается и называется."
          },
          {
            "since": "0.3.0",
            "cmd": "myc code symbol <name>",
            "en": "Where a symbol is defined — and which notes and tasks are anchored inside it.",
            "ru": "Где определён символ — и какие заметки и задачи привязаны внутри него."
          },
          {
            "since": "0.3.0",
            "cmd": "myc callers <name> --depth all",
            "en": "Who calls it, grouped by caller with every line shown; <code>--direction out</code> for what it calls, <code>--depth all</code> for the blast radius, ambiguous names named.",
            "ru": "Кто его вызывает — по вызывающим символам, с каждой строкой; <code>--direction out</code> — что вызывает он, <code>--depth all</code> — радиус поражения, неоднозначные имена названы."
          },
          {
            "since": "0.3.0",
            "cmd": "myc skeleton <file>",
            "en": "A file's API — every declaration with its signature and span — at a fraction of the bytes of reading it.",
            "ru": "API файла — каждое объявление с сигнатурой и спаном — за долю байтов его чтения."
          },
          {
            "since": "0.3.0",
            "cmd": "myc code search \"how is the session resolved\"",
            "en": "Search the code by meaning, when you do not know the name.",
            "ru": "Поиск по коду по смыслу — когда имени не знаешь."
          },
          {
            "since": "0.3.0",
            "cmd": "myc code grep \"<literal>\" --in <path>",
            "en": "Every occurrence of a literal with its owning symbol; <code>--in</code> narrows it (0.3.1), and binary files are skipped out loud.",
            "ru": "Каждое вхождение литерала с его символом-владельцем; <code>--in</code> сужает поиск (0.3.1), бинарные файлы пропускаются вслух."
          },
          {
            "since": "0.3.0",
            "cmd": "myc code map",
            "en": "The repository at a glance: directory clusters, their hubs and who depends on them — an aggregate over tables already built, no index of its own.",
            "ru": "Репозиторий одним взглядом: кластеры каталогов, их хабы и кто от них зависит — агрегат над уже построенными таблицами, без своего индекса."
          },
          {
            "since": "0.2.0",
            "cmd": "myc anchor add <id> <file>:<a>-<b>",
            "en": "Anchors tie a note or a task to a span of code and follow it: lines inserted above keep it fresh, an edit inside makes it stale. Any language.",
            "ru": "Якоря привязывают заметку или задачу к участку кода и едут за ним: строки, вставленные выше, оставляют якорь свежим, правка внутри делает его протухшим. Любой язык."
          },
          {
            "since": "0.3.3",
            "cmd": "myc code index --dry-run",
            "en": "The file list is git's own, so <code>.gitignore</code> applies; a tree without git is walked, and the command says so.",
            "ru": "Список файлов — ровно тот, что даёт git, поэтому <code>.gitignore</code> соблюдается; дерево без git обходится, и команда об этом говорит."
          },
          {
            "since": "0.3.0",
            "cmd": "myc mcp",
            "en": "Six code tools over MCP — symbol, callers, skeleton, search, grep, map — among 13; this repository dropped graft for them.",
            "ru": "Шесть инструментов кода через MCP — symbol, callers, skeleton, search, grep, map — из 13; этот репозиторий ради них отказался от graft."
          }
        ]
      },
      {
        "key": "integrations",
        "title_en": "Integrations and hooks",
        "title_ru": "Интеграции и хуки",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc wire --agents claude,codex,opencode,kimi",
            "en": "One command wires hooks, the MCP server and the skill for Claude Code, Codex and opencode — and Kimi since 0.2.0. JSON configs are merged node by node with a backup; <code>CLAUDE.md</code> is never touched.",
            "ru": "Одна команда ставит хуки, MCP-сервер и скилл для Claude Code, Codex и opencode — и для Kimi с 0.2.0. JSON-конфиги сливаются по узлам с резервной копией; <code>CLAUDE.md</code> не трогается никогда."
          },
          {
            "since": "0.1.0",
            "cmd": "myc wire --dry-run",
            "en": "A foreign hook on the same event is a conflict: nothing is written until <code>--hook-mode</code> says what to do, and <code>--dry-run</code> prints every change first.",
            "ru": "Чужой хук на том же событии — конфликт: ничего не пишется, пока <code>--hook-mode</code> не скажет, что делать, а <code>--dry-run</code> сначала печатает каждое изменение."
          },
          {
            "since": "0.1.0",
            "cmd": "myc unwire",
            "en": "<code>unwire</code> removes exactly what <code>wire</code> installed, by its journal; since 0.3.1 a partial <code>wire --agents X</code> no longer makes it forget the other agents.",
            "ru": "<code>unwire</code> снимает ровно то, что поставил <code>wire</code>, по его журналу; с 0.3.1 частичный <code>wire --agents X</code> больше не заставляет его забыть остальных агентов."
          },
          {
            "since": "0.3.0",
            "cmd": "myc doctor --hooks",
            "en": "Hooks can be verified: when each one fired — counted only for callers that declare themselves — and whether a helper is current, edited after us, or gone.",
            "ru": "Хуки проверяемы: когда срабатывал каждый — считаются только вызовы, назвавшие себя, — и свежий ли помощник, правленый после нас или исчезнувший."
          },
          {
            "since": "0.3.3",
            "cmd": "myc wire --dry-run",
            "en": "<code>wire</code> allows myc's subcommands one by one instead of a broad <code>Bash(myc:*)</code>; <code>run</code>, <code>statusline --then</code>, <code>wire</code> and <code>unwire</code> still ask.",
            "ru": "<code>wire</code> разрешает подкоманды myc по одной, а не широким <code>Bash(myc:*)</code>; <code>run</code>, <code>statusline --then</code>, <code>wire</code> и <code>unwire</code> по-прежнему спрашивают."
          },
          {
            "since": "0.3.4",
            "cmd": "myc wire --agents-md",
            "en": "<code>wire</code> keeps myc's machine files out of git (<code>.myc/.gitignore</code>), and the skill and the AGENTS.md block tell agents about the code tools.",
            "ru": "<code>wire</code> держит машинные файлы myc вне git (<code>.myc/.gitignore</code>), а скилл и блок AGENTS.md рассказывают агентам об инструментах кода."
          }
        ]
      },
      {
        "key": "queue",
        "title_en": "Queue for heavy commands",
        "title_ru": "Очередь тяжёлых команд",
        "items": [
          {
            "since": "0.3.3",
            "cmd": "myc run -- bun test",
            "en": "One queue for the whole machine: the command waits for a slot (first come, first served; one by default, <code>MYC_HEAVY_SLOTS</code> for more), then runs with its own terminal, exit code and signals.",
            "ru": "Одна очередь на всю машину: команда ждёт слот (в порядке прихода; один по умолчанию, <code>MYC_HEAVY_SLOTS</code> — больше), потом выполняется со своим терминалом, кодом выхода и сигналами."
          },
          {
            "since": "0.3.3",
            "cmd": "myc queue",
            "en": "Who runs and who waits: command, directory, session, orca terminal, pid, time; a waiting command says on stderr whom it waits for.",
            "ru": "Кто выполняется и кто ждёт: команда, каталог, сессия, терминал orca, pid, время; ждущая команда пишет в stderr, кого ждёт."
          },
          {
            "since": "0.3.3",
            "cmd": "myc run --max-wait 15m -- make",
            "en": "A holder that dies, even by SIGKILL, frees its slot; past <code>--max-wait</code> (5 minutes by default) the command gives up with exit code 9 and names what is ahead.",
            "ru": "Держатель, который умер — даже от SIGKILL, — освобождает слот; после <code>--max-wait</code> (5 минут по умолчанию) команда сдаётся с кодом 9 и называет, кто впереди."
          },
          {
            "since": "0.3.3",
            "cmd": "myc wire --queue-hook",
            "en": "A Claude Code hook sends full test runs and builds through the queue by itself; a light command passes untouched and never starts bun or node. Opt-in.",
            "ru": "Хук Claude Code сам отправляет полные прогоны тестов и сборки через очередь; лёгкая команда проходит нетронутой и не запускает ни bun, ни node. Только по флагу."
          },
          {
            "since": "0.3.3",
            "cmd": "myc wire --queue-hook --dry-run",
            "en": "Not a way around permissions: a queued command passes silently only when your own rules would pass the original command; otherwise Claude Code asks and shows it whole.",
            "ru": "Не обход прав: команда в очереди проходит без вопроса, только если ваши правила пропустили бы исходную; иначе Claude Code спрашивает и показывает её целиком."
          }
        ]
      },
      {
        "key": "statusline",
        "title_en": "Status line",
        "title_ru": "Строка статуса",
        "items": [
          {
            "since": "0.3.1",
            "cmd": "myc wire --status-line",
            "en": "One line under Claude Code's prompt: the task queue, the code index, the project's memory, and how many of this session's calls to myc returned something. Opt-in.",
            "ru": "Одна строка под приглашением Claude Code: очередь задач, индекс кода, память проекта и сколько обращений к myc в этой сессии дали результат. Только по флагу."
          },
          {
            "since": "0.3.2",
            "cmd": "myc statusline",
            "en": "How full the context is — <code>ctx 42%</code> — taken as is from what the host hands the status line, and absent rather than guessed when it hands nothing.",
            "ru": "Заполненность контекста — <code>ctx 42%</code> — берётся как есть из того, что хост передаёт строке статуса, и отсутствует, а не угадывается, когда он ничего не передаёт."
          },
          {
            "since": "0.3.1",
            "cmd": "myc unwire",
            "en": "The status line that was there before keeps receiving the same input and is never waited on or killed; <code>unwire</code> puts it back byte for byte.",
            "ru": "Строка статуса, стоявшая до неё, получает тот же ввод, её не ждут и не убивают; <code>unwire</code> возвращает её байт в байт."
          },
          {
            "since": "0.3.6",
            "cmd": "myc wire --scope user --status-line",
            "en": "Agents in git worktrees get the line too, from Claude Code's user layer; outside a myc workspace it prints nothing of its own and still hands the input on.",
            "ru": "Агенты в git worktree тоже получают строку — из пользовательского слоя Claude Code; вне воркспейса myc она не печатает ничего своего и всё равно передаёт ввод дальше."
          }
        ]
      },
      {
        "key": "migration",
        "title_en": "Migration from beads",
        "title_ru": "Миграция с beads",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc import-beads <snapshot.json>",
            "en": "Tasks, dependencies, notes and memories. Unknown issue types are carried over verbatim and named, out-of-range priorities clamped and named; a repeated import updates instead of duplicating.",
            "ru": "Задачи, зависимости, заметки и память. Незнакомые типы переносятся дословно и называются, приоритеты вне шкалы прижимаются и называются; повторный импорт обновляет, а не дублирует."
          },
          {
            "since": "0.2.0",
            "cmd": "myc import-beads <snapshot.json> --dry-run",
            "en": "Comments arrive in the node's thread with their authors, and unknown top-level fields are named instead of dropped.",
            "ru": "Комментарии приезжают в нить узла со своими авторами, а незнакомые поля верхнего уровня называются, а не выбрасываются."
          },
          {
            "since": "0.3.3",
            "cmd": "myc show <id>",
            "en": "Acceptance criteria and design go into the task body between managed markers; the source's dates, author and owner are kept, and freshness follows the source until the task is edited in myc.",
            "ru": "Критерии приёмки и дизайн ложатся в тело задачи между управляемыми маркерами; даты, автор и владелец из источника сохраняются, а свежесть следует источнику, пока задачу не правили в myc."
          },
          {
            "since": "0.3.3",
            "cmd": "myc list --status blocked",
            "en": "Statuses myc lacks, such as <code>deferred</code>, become <code>blocked</code> with the original word kept — never <code>open</code>, which would put postponed work into the ready queue.",
            "ru": "Статусы, которых в myc нет, например <code>deferred</code>, становятся <code>blocked</code> с сохранённым исходным словом — и никогда <code>open</code>, иначе отложенная работа попала бы в очередь готовых."
          },
          {
            "since": "0.3.3",
            "cmd": "myc import-beads <snapshot.json>",
            "en": "Run from a sub-repository, the import lands in the shared workspace at the root with that repository's own reach; an empty source is a refusal with a hint, not a silent zero.",
            "ru": "Запущенный из вложенного репозитория, импорт ложится в общий воркспейс в корне с охватом этого репозитория; пустой источник — отказ с подсказкой, а не молчаливый ноль."
          }
        ]
      },
      {
        "key": "web",
        "title_en": "Web interface",
        "title_ru": "Веб-интерфейс",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc viz --open",
            "en": "A local web UI embedded in the binary, with zero external requests: graph, ready queue with its score terms, board, knowledge base, timeline, routing panel, bootstrap editor, health — and search and decisions screens since 0.2.0.",
            "ru": "Локальный веб-интерфейс, вшитый в бинарь, без единого внешнего запроса: граф, очередь готовых со слагаемыми оценки, доска, база знаний, лента, панель роутинга, редактор бутстрапа, здоровье — и с 0.2.0 экраны поиска и решений."
          },
          {
            "since": "0.1.0",
            "cmd": "myc viz --port 7789",
            "en": "Edits go through the same path as the CLI — tasks, notes, properties, comments — while the server itself opens the database read-only, so the CLI keeps writing alongside.",
            "ru": "Правки идут тем же путём, что и в CLI, — задачи, заметки, свойства, комментарии, — а сам сервер открывает базу только на чтение, так что CLI продолжает писать рядом."
          }
        ]
      },
      {
        "key": "worktrees",
        "title_en": "Worktrees and ecosystems",
        "title_ru": "Worktree и экосистемы",
        "items": [
          {
            "since": "0.2.0",
            "cmd": "myc ready",
            "en": "Every git worktree of a repository shares the main tree's workspace: one queue, one memory, leases that mean something; <code>init</code> inside a worktree refuses and explains.",
            "ru": "Все git worktree репозитория делят воркспейс основного дерева: одна очередь, одна память, аренда со смыслом; <code>init</code> внутри worktree отказывает и объясняет почему."
          },
          {
            "since": "0.3.0",
            "cmd": "myc doctor --hooks",
            "en": "Episodes and hook counters live next to the database, not in the working tree, so removing a worktree does not take half a session with it.",
            "ru": "Эпизоды и счётчики хуков живут рядом с базой, а не в рабочем дереве, поэтому удаление worktree не уносит с собой половину сессии."
          },
          {
            "since": "0.3.4",
            "cmd": "myc wire --scope user",
            "en": "Claude Code's user layer for agents in worktrees and nested repositories whose project layer has no myc; the helper stays silent where there is no workspace or the project wires myc itself.",
            "ru": "Пользовательский слой Claude Code — для агентов в worktree и во вложенных репозиториях, где в проектном слое нет myc; помощник молчит там, где нет воркспейса или проект сам подключает myc."
          },
          {
            "since": "0.3.4",
            "cmd": "myc code symbol <name>",
            "en": "A nested repository or a worktree answers code questions from the root's index, with paths relative to where you are; a worktree on another commit gets <code>WARN code_index.worktree_divergent</code>.",
            "ru": "Вложенный репозиторий или worktree отвечает на вопросы о коде из индекса корня, с путями от того места, где вы стоите; worktree на другом коммите получает <code>WARN code_index.worktree_divergent</code>."
          },
          {
            "since": "0.3.6",
            "cmd": "myc anchor of <file>",
            "en": "Anchors of a file are found under both of its keys — written from the root or from inside the nested repository — from anywhere in the workspace; worktrees inside the tree are not indexed as another copy.",
            "ru": "Якоря файла находятся под обоими его ключами — записанными из корня и изнутри вложенного репозитория — откуда угодно в воркспейсе; worktree внутри дерева не индексируются как ещё одна копия."
          }
        ]
      },
      {
        "key": "security",
        "title_en": "Security",
        "title_ru": "Безопасность",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc version --check",
            "en": "No network of its own: only commands you type reach it — <code>models fetch</code>, <code>code fetch</code> (0.3.0), <code>version --check</code> (0.2.0). The automatic update check is off by default, and nothing updates itself.",
            "ru": "Своей сети нет: в неё ходят только набранные вами команды — <code>models fetch</code>, <code>code fetch</code> (0.3.0), <code>version --check</code> (0.2.0). Автоматическая проверка обновлений выключена по умолчанию, и само ничего не обновляется."
          },
          {
            "since": "0.3.4",
            "cmd": "myc code grep \"<literal>\" --in .env",
            "en": "Secret-named files — <code>.env</code>, keys, keystores, credentials — are never indexed, whatever <code>.gitignore</code> says, and <code>code grep</code> refuses to read one.",
            "ru": "Файлы с секретными именами — <code>.env</code>, ключи, хранилища ключей, учётные данные — не индексируются никогда, что бы ни говорил <code>.gitignore</code>, а <code>code grep</code> отказывается их читать."
          },
          {
            "since": "0.1.0",
            "cmd": "myc absorb-session --reason manual",
            "en": "Secrets are masked before a session episode is written; since 0.3.0 that includes <code>password=</code>, <code>api_key=</code>, <code>PGPASSWORD=</code> and their kin, with a word boundary so prose stays prose.",
            "ru": "Секреты маскируются до записи эпизода сессии; с 0.3.0 это и <code>password=</code>, <code>api_key=</code>, <code>PGPASSWORD=</code> с роднёй — по границе слова, чтобы проза оставалась прозой."
          },
          {
            "since": "0.3.5",
            "cmd": "myc run -- env",
            "en": "myc reads neither the project's <code>.env</code> nor its <code>bunfig.toml</code>, and <code>myc run</code> passes your environment exactly as it was.",
            "ru": "myc не читает ни <code>.env</code>, ни <code>bunfig.toml</code> проекта, а <code>myc run</code> передаёт ваше окружение ровно таким, каким оно было."
          }
        ]
      },
      {
        "key": "sync",
        "title_en": "Sync and diagnostics",
        "title_ru": "Синхронизация и диагностика",
        "items": [
          {
            "since": "0.1.0",
            "cmd": "myc export",
            "en": "Only the oplog goes to git, and a merge driver unions it by operation id; two machines editing the same node converge per field, not per record.",
            "ru": "В git уходит только оплог, и merge-драйвер объединяет его по id операций; две машины, правившие один узел, сходятся по полям, а не по записям целиком."
          },
          {
            "since": "0.2.0",
            "cmd": "myc doctor",
            "en": "A copied workspace (cp -R, a backup, an image) gets its own site id, so copies merge instead of losing operations; a colliding operation refuses the merge and keeps both versions.",
            "ru": "Скопированный воркспейс (cp -R, резервная копия, образ) получает свой site id, и копии сливаются, а не теряют операции; столкнувшаяся операция отказывает в слиянии и сохраняет обе версии."
          },
          {
            "since": "0.2.0",
            "cmd": "myc doctor --recount",
            "en": "<code>doctor</code> checks what the database claims against what can be recounted — schema, counters, hooks — and says <code>unknown</code> where it did not look.",
            "ru": "<code>doctor</code> сверяет то, что утверждает база, с тем, что можно пересчитать, — схему, счётчики, хуки — и говорит <code>unknown</code> там, куда не смотрел."
          },
          {
            "since": "0.1.0",
            "cmd": "myc ready --json",
            "en": "Every command answers in one JSON envelope (<code>--json</code>, <code>--ndjson</code>) with its degradations and warnings, and exit codes that tell a refusal from a failure.",
            "ru": "Каждая команда отвечает одним JSON-конвертом (<code>--json</code>, <code>--ndjson</code>) с деградациями и предупреждениями, а коды выхода отличают отказ от сбоя."
          },
          {
            "since": "0.3.2",
            "cmd": "myc --help",
            "en": "Everything the CLI and the MCP server print is English, the messages shown when Bun is missing included; Russian notes and transcripts are still understood.",
            "ru": "Всё, что печатают CLI и MCP-сервер, — на английском, включая сообщения на случай, когда нет Bun; русские заметки и транскрипты по-прежнему понимаются."
          }
        ]
      }
    ]
  },
  "planned": {
    "command": "myc list --kind epic",
    "epics": [
      {
        "id": "memory-5xravkn0anzk",
        "en": "The core works and this project runs on it; what is open is the formal acceptance and two known costs.",
        "ru": "Ядро работает, и этот проект живёт на нём; открыты формальная приёмка и две известные цены.",
        "items": [
          {
            "id": "memory-e7gn61sp2mfp",
            "en": "Acceptance: a live project works a week only through myc — no return to beads, no hand repair of the database.",
            "ru": "Приёмка: живой проект неделю работает только через myc — без возврата к beads и без ручного ремонта базы."
          },
          {
            "id": "memory-vt0rkpv0xwn2",
            "en": "A fair ready queue between agents: concurrent claims are correct, but the winner of the race keeps winning.",
            "ru": "Справедливая очередь ready между агентами: конкурентный захват корректен, но выигравший гонку продолжает выигрывать."
          },
          {
            "id": "memory-tatk1jg3qjfs",
            "en": "The post-edit hook loads the background-work step and opens the database on every edit, for an operation that costs a fraction of that.",
            "ru": "Хук post-edit на каждую правку тянет шаг фоновой работы и открывает базу — ради операции, которая стоит долю этого."
          }
        ]
      },
      {
        "id": "memory-kh9wpqkwj1dm",
        "items": [
          {
            "id": "memory-da4pb1ws4zhk",
            "en": "Retention of raw memory: decay, prune and purge of L0 episodes — never touching what has not been distilled.",
            "ru": "Срок хранения сырой памяти: затухание, прореживание и удаление эпизодов L0 — не трогая недистиллированное."
          },
          {
            "id": "memory-kj05ajqrrq3x",
            "en": "Decide the fate of <code>score_rel</code> in the public JSON and MCP contract, and write the migration note.",
            "ru": "Решить судьбу <code>score_rel</code> в публичном контракте JSON и MCP и написать заметку о миграции."
          }
        ]
      },
      {
        "id": "memory-vtvz9sdjekgx",
        "items": [
          {
            "id": "memory-q036cwa85b04",
            "en": "<code>myc digest</code>: facts, open actions, contradictions, edges and sources on one topic, in one call.",
            "ru": "<code>myc digest</code>: факты, открытые действия, противоречия, рёбра и источники по теме — одним вызовом."
          },
          {
            "id": "memory-wfgj2r5j39qv",
            "en": "Let the native embedding backend take over without reindexing: its vectors differ from the WASM ones far below int8 quantisation error.",
            "ru": "Дать нативному бэкенду эмбеддингов заменить WASM без переиндексации: их векторы расходятся намного меньше ошибки квантизации int8."
          }
        ]
      },
      {
        "id": "memory-4ez67f48fcdv",
        "en": "The code index and anchors work; what is open is anchors surviving refactors, and the acceptance itself.",
        "ru": "Индекс кода и якоря работают; открыто выживание якорей при рефакторинге и сама приёмка.",
        "items": [
          {
            "id": "memory-apq1h7wra93w",
            "en": "Acceptance: from a symbol to its decisions and back, on a real repository, correct after a refactor.",
            "ru": "Приёмка: от символа к решениям и обратно на реальном репозитории — и корректно после рефакторинга."
          },
          {
            "id": "memory-5c03r9t5n472",
            "en": "Re-attach anchors after a refactor by finding the moved code, with a confidence threshold and an explicit list of what stayed unresolved.",
            "ru": "Перепривязка якорей после рефакторинга: поиск переехавшего кода с порогом уверенности и явным списком неразрешённого."
          },
          {
            "id": "memory-g79mpkt53yn3",
            "en": "A symbol's fan-in computed in the background and stored, so reading it is a column read with no external call.",
            "ru": "Fan-in символа считается в фоне и хранится числом — читать его значит прочитать колонку, без внешних вызовов."
          }
        ]
      },
      {
        "id": "memory-x20k85amw3z9",
        "en": "The epic is closed: graft is out of this repository. One measured follow-up is left.",
        "ru": "Эпик закрыт: graft из этого репозитория убран. Остался один замеренный хвост.",
        "items": [
          {
            "id": "memory-eyqdv56a95s5",
            "en": "Retune the parse pool: with tree-sitter, eight workers cost more than they save.",
            "ru": "Перенастроить пул разбора: на tree-sitter восемь воркеров стоят дороже, чем экономят."
          }
        ]
      },
      {
        "id": "memory-14qyv1gmacef",
        "items": [
          {
            "id": "memory-n2tcwbwcwxzb",
            "en": "A queue segment in the status line: how many are waiting, and how long I have been waiting.",
            "ru": "Сегмент очереди в строке статуса: сколько ждут и сколько уже жду я."
          },
          {
            "id": "memory-40r75txge0fb",
            "en": "Slots and lanes from a config file, <code>~/.myc/queue.toml</code>, with a default derived from the number of cores.",
            "ru": "Слоты и полосы из файла настроек <code>~/.myc/queue.toml</code>, с умолчанием по числу ядер."
          }
        ]
      },
      {
        "id": "memory-aw5d21x3wa87",
        "en": "Today myc is single-user over files in git. M4 is the team half; none of the server exists yet beyond a package with health endpoints and no command.",
        "ru": "Сегодня myc однопользовательский, над файлами в git. M4 — командная половина; от сервера пока есть только пакет с эндпоинтами здоровья и без команды.",
        "items": [
          {
            "id": "memory-bjy6fq9kxj47",
            "en": "<code>myc serve</code>: an HTTP API with Bearer tokens and several workspaces in one process that cannot see each other's data.",
            "ru": "<code>myc serve</code>: HTTP API с Bearer-токенами и несколькими воркспейсами в одном процессе, не видящими данных друг друга."
          },
          {
            "id": "memory-w0r3vhgkxmsw",
            "en": "ACL at four levels — private, team, restricted, agent — filtered before ranking, compiled into every retrieval query.",
            "ru": "ACL на четыре уровня — private, team, restricted, agent — с фильтром до ранжирования, вкомпилированным в каждый запрос ретривала."
          },
          {
            "id": "memory-0sbdhdt7fm36",
            "en": "<code>myc sync</code>: exchange the oplog with a server from a sequence number; three clients with offline edits converge in any order.",
            "ru": "<code>myc sync</code>: обмен оплогом с сервером начиная с номера операции; три клиента с офлайн-правками сходятся в любом порядке."
          },
          {
            "id": "memory-dastrwgyzty9",
            "en": "Network sync over the oplog exchange git already proves: same oplog, same deduplication, a different transport.",
            "ru": "Сетевая синхронизация поверх обмена оплогом, уже доказанного через git: тот же оплог, та же дедупликация, другой транспорт."
          },
          {
            "id": "memory-2xgh8mg2fs24",
            "en": "A Postgres store — tsvector and pgvector HNSW over halfvec — passing the same query set as SQLite with the same results.",
            "ru": "Хранилище на Postgres — tsvector и pgvector HNSW по halfvec, — проходящее тот же набор запросов, что и SQLite, с теми же результатами."
          },
          {
            "id": "memory-zzz7w3c8dc6x",
            "en": "Migration from SQLite to Postgres without loss and without re-embedding when the embedding fingerprint matches.",
            "ru": "Переезд с SQLite на Postgres без потерь и без пересчёта векторов, если совпал отпечаток эмбеддингов."
          },
          {
            "id": "memory-krn44m79r4dr",
            "en": "Live updates over SSE, resumable by <code>Last-Event-ID</code> = the oplog sequence, so a reconnect neither loses nor repeats events.",
            "ru": "Живые обновления по SSE с продолжением по <code>Last-Event-ID</code> = номер операции оплога, чтобы переподключение ничего не теряло и не повторяло."
          },
          {
            "id": "memory-s8zk9v8h5rp0",
            "en": "MCP profiles for a leader agent and a full one, narrowed by the role of the token when working through the server.",
            "ru": "MCP-профили для ведущего агента и полный, суженные ролью токена при работе через сервер."
          },
          {
            "id": "memory-3n0svbkbjaew",
            "en": "Containers and a compose topology: myc plus pgvector, an optional embedder sidecar, health and readiness endpoints.",
            "ru": "Контейнеры и compose-топология: myc и pgvector, необязательный сайдкар эмбеддера, эндпоинты здоровья и готовности."
          },
          {
            "id": "memory-gpknypxyk91j",
            "en": "A graph view served by the server for large graphs; the local <code>myc viz</code> graph already lays out up to 25 000 nodes.",
            "ru": "Представление графа, отдаваемое сервером, для больших графов; локальный граф <code>myc viz</code> уже раскладывает до 25 000 узлов."
          },
          {
            "id": "memory-czm24d25q295",
            "en": "Acceptance: two people and four agents work a week through one shared server — no data conflicts, no way around the ACL.",
            "ru": "Приёмка: два человека и четыре агента неделю работают через общий сервер — без конфликтов данных и без обхода ACL."
          }
        ]
      },
      {
        "id": "memory-0dm3hdvdmr5c",
        "en": "Not started. What exists is the data it would learn from: attempts, a model roster with prices, a report of cost per result.",
        "ru": "Не начато. Есть данные, на которых оно училось бы: попытки, ростер моделей с ценами, отчёт о цене результата.",
        "items": [
          {
            "id": "memory-fxazm220dtsq",
            "en": "Tables for attempts, outcome signals and routing decisions, outside the oplog, with priors.",
            "ru": "Таблицы попыток, сигналов исхода и решений роутинга — вне оплога, с приорами."
          },
          {
            "id": "memory-y1k58t110cdq",
            "en": "The attempt lifecycle through hooks and git trailers, so an agent's commit is tied to its attempt — and the absence of those hooks is loud.",
            "ru": "Жизненный цикл попытки через хуки и git-трейлеры, чтобы коммит агента связывался с его попыткой, — а отсутствие этих хуков было громким."
          },
          {
            "id": "memory-0wfmcf2kgbvb",
            "en": "A task fingerprint: 28 classes of intent × scope, computed without a model from the text, the anchors and the graph.",
            "ru": "Отпечаток задачи: 28 классов «намерение × масштаб», считаемых без модели по тексту, якорям и графу."
          },
          {
            "id": "memory-ch6qen5t9rbe",
            "en": "Outcome signals with weights, telling a model's failure from a badly posed task, and delayed events such as a revert a week later.",
            "ru": "Сигналы исхода с весами, отличающие провал модели от плохо поставленной задачи, и отложенные события вроде реверта через неделю."
          },
          {
            "id": "memory-qe0dtdf1h3rz",
            "en": "A cost model and one utility over quality, cost and latency, with weight profiles.",
            "ru": "Модель стоимости и единая полезность по качеству, цене и задержке — с профилями весов."
          },
          {
            "id": "memory-z7k5x3bppvr0",
            "en": "Thompson sampling over hierarchical priors, with an exploration floor so a model that stops being chosen can still recover.",
            "ru": "Томпсон-семплинг по иерархическим приорам — с полом исследования, чтобы модель, которую перестали выбирать, могла вернуться."
          },
          {
            "id": "memory-91apr1tp1qzw",
            "en": "Honest evaluation: logged propensities, IPS/SNIPS/doubly robust offline and a control group online; savings with a confidence interval, not one number.",
            "ru": "Честная оценка: логируемые пропенсити, IPS/SNIPS/doubly robust офлайн и контрольная группа онлайн; экономия с доверительным интервалом, а не одним числом."
          },
          {
            "id": "memory-ast410zxvdpd",
            "en": "Forgetting and a regime-change detector: priors decay, a new model version inherits half-weight, a sudden change of behaviour is caught.",
            "ru": "Забывание и детектор смены режима: приоры затухают, новая версия модели наследует половинный вес, резкая смена поведения ловится."
          },
          {
            "id": "memory-xjzvw9fyxkz0",
            "en": "Cheap-then-expensive cascades only where there is something to verify the result with, and a formula for the escalation threshold.",
            "ru": "Каскад «дёшево, потом дорого» — только там, где есть чем проверить результат, и формула порога эскалации."
          },
          {
            "id": "memory-76byppzy2a2k",
            "en": "<code>myc route</code> and an MCP tool: model, effort, confidence, expected price and an alternative, in under 10 ms and never over the network.",
            "ru": "<code>myc route</code> и MCP-инструмент: модель, уровень усилий, уверенность, ожидаемая цена и альтернатива — быстрее 10 мс и никогда через сеть."
          },
          {
            "id": "memory-zga00epa0rky",
            "en": "Privacy of shared priors: only enum features, buckets, salted hashes and sums leave the machine, and the server's schema rejects anything else.",
            "ru": "Приватность общих приоров: с машины уходят только признаки-перечисления, бакеты, солёные хеши и суммы, а схема сервера отвергает остальное."
          },
          {
            "id": "memory-d64pv4dw3m1j",
            "en": "A shared pool of agent statistics — its own card in this section.",
            "ru": "Общий пул статистики агентов — отдельной карточкой в этом разделе."
          },
          {
            "id": "memory-0adbcy3rhqj4",
            "en": "Acceptance: on accumulated data, routing saves against a fixed strong model beyond the confidence interval, reproduced on a held-out sample.",
            "ru": "Приёмка: на накопленных данных роутинг экономит против фиксированной сильной модели за пределами доверительного интервала, и это воспроизводится на отложенной выборке."
          }
        ]
      },
      {
        "id": "memory-d64pv4dw3m1j",
        "en": "Not started, and deliberately staged: each step goes ahead only if the previous one shows value.",
        "ru": "Не начато и нарочно разбито на ступени: следующая идёт, только если предыдущая показала пользу.",
        "items": [
          {
            "id": "memory-rsje5wn1w75r",
            "en": "An outcome label with spread: attempts record themselves, with the orchestrator and the judge in them; rework and cross-verdicts become signals.",
            "ru": "Метка исхода с разбросом: попытки пишутся сами, с оркестратором и судьёй внутри; доработки и перекрёстные вердикты становятся сигналами."
          },
          {
            "id": "memory-gxbf5h1kwya6",
            "en": "Value for one user first: can the difference between models be seen on one repository's data? If not, the pool stops here.",
            "ru": "Сначала польза одному пользователю: видна ли разница между моделями на данных одного репозитория? Если нет — пул на этом останавливается."
          },
          {
            "id": "memory-x80d134ygdwy",
            "en": "A closed pool for one organisation, with the orchestrator and the judge as dimensions of each cell.",
            "ru": "Закрытый пул одной организации, где оркестратор и судья — измерения каждой ячейки."
          },
          {
            "id": "memory-7n2h02wm1eer",
            "en": "A public pool by consent only: off by default, <code>myc share --preview</code> shows exactly what would be sent, cells published only with enough distinct repositories.",
            "ru": "Публичный пул только по согласию: выключен по умолчанию, <code>myc share --preview</code> показывает ровно то, что уйдёт, ячейки публикуются только при достаточном числе разных репозиториев."
          }
        ]
      },
      {
        "id": "memory-6dzxkzwbsc9g",
        "en": "Not started. It is the only part that would need an LLM key — and without a key, everything above keeps working.",
        "ru": "Не начато. Это единственная часть, которой понадобился бы ключ к модели, — и без ключа всё остальное продолжает работать.",
        "items": [
          {
            "id": "memory-b990rs205an8",
            "en": "An LLM provider layer (OpenAI- and Anthropic-compatible) for background work only; a missing key breaks no command.",
            "ru": "Слой LLM-провайдеров (совместимых с OpenAI и Anthropic) только для фоновой работы; отсутствие ключа не ломает ни одной команды."
          },
          {
            "id": "memory-ez3a7gpgccce",
            "en": "A distiller from raw episodes to atoms — facts, preferences, constraints, events — async, cancellable, with a hard budget per run.",
            "ru": "Дистиллятор из сырых эпизодов в атомы — факты, предпочтения, ограничения, события — асинхронный, отменяемый, с жёстким бюджетом на прогон."
          },
          {
            "id": "memory-jqgga8mrgbzm",
            "en": "Promotion L1 → L2 → L3 as new nodes with a derived_from edge, so history stays whole.",
            "ru": "Подъём L1 → L2 → L3 новыми узлами с ребром derived_from, чтобы история оставалась целой."
          },
          {
            "id": "memory-44rwc3hw1h7g",
            "en": "An optional LLM stage for memory classification where the deterministic one is unsure, with the verdict's origin visible.",
            "ru": "Необязательная ступень классификации памяти на LLM там, где детерминированной не хватило уверенности, — с видимым происхождением вердикта."
          },
          {
            "id": "memory-7mgcnf2z2eeh",
            "en": "Skills as a surface: versioned, picked by their launch conditions.",
            "ru": "Навыки как поверхность: с версиями и подбором по условиям запуска."
          },
          {
            "id": "memory-3akx1aywngt6",
            "en": "An OpenAI-compatible proxy that adds memory for clients that cannot be configured — off by default, since all traffic would pass through it.",
            "ru": "OpenAI-совместимый прокси, подмешивающий память клиентам, которых нельзя настроить, — выключен по умолчанию: через него пошёл бы весь трафик."
          },
          {
            "id": "memory-dpbjv4e8wz2m",
            "en": "Acceptance: on a project with months of history, prime gives context a person would call right, with no hand-written notes — checked blind on three projects.",
            "ru": "Приёмка: на проекте с многомесячной историей prime даёт контекст, который человек признал бы верным, без ручных заметок, — слепая проверка на трёх проектах."
          }
        ]
      }
    ]
  },
  "tests": {
    "command": "bun test",
    "pass": 3438,
    "fail": 0,
    "skip": 16,
    "files": 225,
    "assertions": 34244,
    "seconds": 315.5,
    "sources": "3c881153bf04d961",
    "date": "2026-09-11",
    "myc": "0.3.6"
  }
};
window.MYC_DATA.verified = { at: "2026-09-11T21:19:21.624Z", assertions: 77 };
window.MYC_DATA.release = "0.3.6";
