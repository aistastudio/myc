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
    "note_en": "Every number on the site was taken on this machine on this date, unless the entry names another source.",
    "note_ru": "Все числа сайта сняты на этой машине в этот день, если в записи не назван другой источник."
  },
  "latency": {
    "command": "bun run scripts/bench-latency.ts",
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
        "p50": 0.561,
        "p95": 0.678,
        "p99": 0.755,
        "budget": 30,
        "n": 750
      },
      {
        "op": "read",
        "label_en": "read one node",
        "label_ru": "чтение узла",
        "p50": 0.004,
        "p95": 0.006,
        "p99": 0.012,
        "budget": 3,
        "n": 750
      },
      {
        "op": "search",
        "label_en": "hybrid search",
        "label_ru": "гибридный поиск",
        "p50": 8.852,
        "p95": 9.493,
        "p99": 10.354,
        "budget": 25,
        "n": 750
      },
      {
        "op": "write",
        "label_en": "write",
        "label_ru": "запись",
        "p50": 0.258,
        "p95": 0.376,
        "p99": 0.46,
        "budget": 5,
        "n": 300
      },
      {
        "op": "cold_start",
        "label_en": "cold start of the binary",
        "label_ru": "холодный старт бинаря",
        "p50": 21.935,
        "p95": 23.793,
        "p99": 23.82,
        "budget": 60,
        "n": 25
      }
    ]
  },
  "boost": {
    "command": "bun run bench/boost-eval.ts",
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
      "myc": 195,
      "bd": 144,
      "diff": 51,
      "myc_command": "myc ready --json",
      "bd_command": "bd ready",
      "issue": "memory-atcm254ry6c7"
    }
  },
  "package": {
    "command": "bun run pack:npm",
    "compressed_mb": 3.17,
    "unpacked_mb": 11.92,
    "files": 10,
    "install_command": "bun install -g @aistastudio/myc",
    "model": {
      "command": "myc models fetch multilingual-e5-small-q8",
      "mb": 129.1,
      "seconds": 7.3,
      "source": "docs/reports/REPORT-npm-package.md",
      "measured_here": false
    }
  },
  "roadmap": {
    "command": "myc show <epic-id>",
    "rows": [
      {
        "id": "memory-5xravkn0anzk",
        "key": "M0",
        "title_en": "core and tasks",
        "title_ru": "ядро и задачи",
        "done": 30,
        "total": 33
      },
      {
        "id": "memory-ancs66k238nv",
        "key": "M0.5",
        "title_en": "self-hosting: myc developed through myc",
        "title_ru": "самохостинг: myc разрабатывается через myc",
        "done": 4,
        "total": 4
      },
      {
        "id": "memory-kh9wpqkwj1dm",
        "key": "M1",
        "title_en": "memory",
        "title_ru": "память",
        "done": 20,
        "total": 23
      },
      {
        "id": "memory-vtvz9sdjekgx",
        "key": "M2",
        "title_en": "semantics",
        "title_ru": "семантика",
        "done": 16,
        "total": 19
      },
      {
        "id": "memory-cmg64b6vrw0b",
        "key": "M7",
        "title_en": "human interface: board, cards, threads",
        "title_ru": "человек в интерфейсе: доска, карточки, нити",
        "done": 11,
        "total": 14
      },
      {
        "id": "memory-4ez67f48fcdv",
        "key": "M3",
        "title_en": "code intelligence: anchors code <-> knowledge",
        "title_ru": "код: якоря код ↔ знание",
        "done": 3,
        "total": 9
      },
      {
        "id": "memory-aw5d21x3wa87",
        "key": "M4",
        "title_en": "team: myc serve, ACL, network sync, Postgres",
        "title_ru": "команда: myc serve, ACL, сетевая синхронизация, Postgres",
        "done": 1,
        "total": 12
      },
      {
        "id": "memory-0dm3hdvdmr5c",
        "key": "M5",
        "title_en": "swarm self-learning: routing by cost and outcome",
        "title_ru": "самообучение роя: роутинг по цене и результату",
        "done": 0,
        "total": 12
      },
      {
        "id": "memory-6dzxkzwbsc9g",
        "key": "M6",
        "title_en": "distillation",
        "title_ru": "дистилляция",
        "done": 0,
        "total": 7
      }
    ]
  },
  "tests": {
    "command": "bun test",
    "pass": 2139,
    "fail": 0,
    "skip": 16,
    "files": 144,
    "assertions": 27696,
    "seconds": 181.88,
    "failing_note_en": "One test is red as of this run: it belongs to packages/web, where interface search (W6) is still open work. It is named here rather than hidden — a page that claims measurement cannot round a failing test down to zero.",
    "failing_note_ru": "Один тест на этот прогон красный: он живёт в packages/web, где ещё идёт работа над поиском в интерфейсе (W6). Он назван здесь, а не спрятан: страница, которая ссылается на замеры, не имеет права округлить падение до нуля.",
    "commit": "776b2dbe9d536bd8dae9c8f24160229e3d71c50d"
  }
};
window.MYC_DATA.verified = { at: "2026-09-07T21:05:05.854Z", assertions: 67 };
