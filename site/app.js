/* myc — отрисовка сайта.
   Числа берутся ТОЛЬКО из window.MYC_DATA (файл data.js, который выпускает
   site/build.ts после сверки с артефактами репозитория). В этом файле нет ни
   одной константы-числа о продукте — если что-то не пришло из данных, оно и не
   нарисуется. Тексты рисуются сразу на двух языках; переключатель прячет одну
   половину средствами CSS, поэтому страница не перерисовывается, не
   перезагружается и не теряет позицию прокрутки. */
(function () {
  "use strict";

  var D = window.MYC_DATA;
  if (!D) { document.body.insertAdjacentHTML("afterbegin", "<pre style='padding:2rem;color:#d03b3b'>data.js не собран: запустите bun run site/build.ts</pre>"); return; }

  // ── мелкая помощь ──────────────────────────────────────────────────────────
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "style") n.setAttribute("style", attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }
  /** Двуязычный фрагмент: обе половины в DOM, видна одна — та, что выбрана. */
  function bi(en, ru, tag) {
    var f = document.createDocumentFragment();
    f.appendChild(el(tag || "span", { lang: "en", html: en }));
    f.appendChild(el(tag || "span", { lang: "ru", html: ru }));
    return f;
  }
  function put(id, node) { var host = document.getElementById(id); if (host) host.appendChild(node); }
  function num(x, d) { return Number(x).toFixed(d == null ? 3 : d); }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  /** Текст из трекера вставляется как текст, а не как разметка. */
  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cmpVer(a, b) {
    var x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }

  var SERIES = "var(--series-1)";
  var STEP = ["var(--ord-1)", "var(--ord-2)", "var(--ord-3)"];

  /** Строка команды с кнопкой копирования. */
  function cmd(text) {
    return el("div", { class: "cmd" },
      el("span", { class: "prompt", text: "$" }),
      el("code", { text: text }),
      el("button", { class: "copy", type: "button", text: "copy" }));
  }

  /** Таблица: заголовки — двуязычные пары [en, ru]; ячейки — строки или узлы. */
  function table(heads, rows, numericFrom) {
    var thead = el("tr");
    heads.forEach(function (h, i) {
      var th = el("th", { class: i >= numericFrom ? "num" : "" });
      th.appendChild(bi(h[0], h[1]));
      thead.appendChild(th);
    });
    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      r.forEach(function (c, i) {
        var td = el("td", { class: i >= numericFrom ? "num" : "" });
        td.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    return el("div", { class: "tablewrap" }, el("table", null, el("thead", null, thead), tbody));
  }

  function legend(items) {
    var l = el("div", { class: "legend" });
    items.forEach(function (it) {
      var s = el("span", null, el("span", { class: "swatch", style: "background:" + it.color }));
      s.appendChild(bi(it.en, it.ru));
      l.appendChild(s);
    });
    return l;
  }

  function statTile(value, unit, keyEn, keyRu, noteEn, noteRu) {
    var v = el("div", { class: "v tnum", text: value });
    if (unit) v.appendChild(el("span", { class: "u", text: unit }));
    var t = el("div", { class: "stat" }, v);
    t.appendChild(el("div", { class: "k" })).appendChild(bi(keyEn, keyRu));
    if (noteEn) t.appendChild(el("div", { class: "n" })).appendChild(bi(noteEn, noteRu));
    return t;
  }

  // ── шапка и подвал ─────────────────────────────────────────────────────────
  // Шапка — текущий релиз (packages/cli/package.json, сверено site/build.ts);
  // env.myc — версия, на которой сняты замеры, она остаётся в подвале.
  // Подвал называет дату КАЖДОГО замера: одна общая дата на странице, где
  // задержки сняты на 0.1.1, а пакет и тесты — на текущем релизе, выдавала бы
  // старые числа за новые или новые за старые.
  var release = D.release || D.package.version;
  document.getElementById("brand-ver").textContent = release;
  document.querySelectorAll(".js-release").forEach(function (n) { n.textContent = release; });
  put("footer-env", bi(
    "Measured " + D.env.date + " on " + D.env.machine + " — Bun " + D.env.bun +
      ", myc " + D.env.myc + ", beads " + D.env.beads + ". " + D.env.note_en +
      " Ranking re-run " + D.boost.date + "; the two ready queues " + D.import.ready_gap.date +
      "; package " + D.package.version + " measured " + D.package.date + "; tests on myc " + D.tests.myc + ", " + D.tests.date +
      "; milestones counted from myc " + D.roadmap.as_of + "." +
      " Site data verified by site/build.ts: " + D.verified.assertions + " assertions.",
    "Измерено " + D.env.date + " на " + D.env.machine + " — Bun " + D.env.bun +
      ", myc " + D.env.myc + ", beads " + D.env.beads + ". " + D.env.note_ru +
      " Ранжирование перемерено " + D.boost.date + "; две очереди готовых задач — " + D.import.ready_gap.date +
      "; пакет " + D.package.version + " померен " + D.package.date + "; тесты — на myc " + D.tests.myc + ", " + D.tests.date +
      "; вехи посчитаны из myc " + D.roadmap.as_of + "." +
      " Данные сайта сверены site/build.ts: " + D.verified.assertions + " утверждений."));

  // ── герой ──────────────────────────────────────────────────────────────────
  (function () {
    var prime = D.latency.rows[0];
    var tiles = [
      { node: statTile(num(prime.p99, 2), "ms", "p99 of <code>myc prime</code>, 100 000 nodes", "p99 у <code>myc prime</code>, 100 000 узлов",
          "budget " + prime.budget + " ms — " + Math.round(prime.budget / prime.p99) + "× headroom",
          "бюджет " + prime.budget + " мс — запас ×" + Math.round(prime.budget / prime.p99)),
        cmd: D.latency.command },
      { node: statTile(num(D.boost.overall.on.mrr, 3), "MRR@10", "with boosts, up from " + num(D.boost.overall.off.mrr, 3), "с бустами, было " + num(D.boost.overall.off.mrr, 3),
          D.boost.corpus.queries + " labelled queries, control group drops", D.boost.corpus.queries + " размеченных запросов, контрольная группа падает"),
        cmd: D.boost.command },
      { node: statTile(String(D.package.compressed_mb), "MB", D.package.files + " files, no models pulled at install", D.package.files + " файлов, модели при установке не качаются",
          "unpacked " + D.package.unpacked_mb + " MB", "распакованный " + D.package.unpacked_mb + " МБ"),
        cmd: D.package.command }
    ];
    tiles.forEach(function (t) {
      var card = el("div", { class: "card" }, t.node);
      card.appendChild(el("div", { style: "margin-top:.9rem" }, cmd(t.cmd)));
      put("hero-stats", card);
    });
  })();

  // ── 01 установка ───────────────────────────────────────────────────────────
  (function () {
    var p = D.package;
    document.getElementById("pkg-sub").appendChild(bi(
      "<strong>" + p.compressed_mb + " MB</strong> compressed, " + p.unpacked_mb + " MB unpacked, <strong>" + p.files + " files</strong>. The embedding model is not downloaded during install.",
      "<strong>" + p.compressed_mb + " МБ</strong> сжатый, " + p.unpacked_mb + " МБ распакованный, <strong>" + p.files + " файлов</strong>. Модель эмбеддингов при установке не качается."));

    var how = document.getElementById("pkg-how");
    how.appendChild(bi("The tarball is built and measured by one command:", "Тарбол собирается и меряется одной командой:", "p"));
    how.appendChild(cmd(p.command));
    how.appendChild(table(
      [["what", "что"], ["value", "значение"]],
      [[bi("compressed tarball", "сжатый тарбол"), p.compressed_mb + " MB"],
       [bi("unpacked on disk", "распакованный на диске"), p.unpacked_mb + " MB"],
       [bi("files in the package", "файлов в пакете"), String(p.files)]], 1));

    document.getElementById("model-sub").appendChild(bi(
      "The model is " + p.model.mb + " MB and is fetched only when you ask for it (" + p.model.seconds + " s, measured in <code>" + p.model.source + "</code> — this one figure is quoted from that report, not re-measured here).",
      "Модель весит " + p.model.mb + " МБ и качается только по вашей команде (" + p.model.seconds + " с, замер в <code>" + p.model.source + "</code> — это единственное число, взятое из отчёта, а не переснятое здесь)."));
  })();

  // ── 02 бюджеты латентности ─────────────────────────────────────────────────
  (function () {
    var L = D.latency;
    var LE = L.env || D.env; // задержки переснимаются отдельно — у них свои условия
    document.getElementById("lat-sub").appendChild(bi(
      L.corpus_en + ". The track is the budget; the fill is the measured p99 — taken " + LE.date + " on myc " + LE.myc + ", on " + LE.machine + ", and not re-taken since.",
      L.corpus_ru + ". Дорожка — бюджет, заливка — измеренный p99, снятый " + LE.date + " на myc " + LE.myc + ", машина " + LE.machine + ", и с тех пор не переснимавшийся."));

    var host = document.getElementById("lat-chart");
    L.rows.forEach(function (r) {
      var share = Math.min(1, r.p99 / r.budget);
      var row = el("div", { class: "budget-row" });
      var lab = el("div", { class: "rl" }); lab.appendChild(bi(r.label_en, r.label_ru)); row.appendChild(lab);
      var track = el("div", { class: "budget-track" },
        el("div", { class: "budget-fill", style: "width:calc(" + (share * 100).toFixed(2) + "% - 2px)",
          "data-tip": r.op + ": p99 " + num(r.p99, 3) + " ms / " + r.budget + " ms" }),
        el("span", { class: "budget-cap", text: "budget " + r.budget + " ms" }));
      row.appendChild(track);
      var hr = el("div", { class: "headroom" }, document.createTextNode(num(r.p99, 3) + " ms "));
      hr.appendChild(el("em", { text: "×" + Math.round(r.budget / r.p99) }));
      row.appendChild(hr);
      host.appendChild(row);
    });

    var how = document.getElementById("lat-how");
    how.appendChild(bi("Run it yourself — the script also refuses a p95 regression over " +
        (L.check.tolerance * 100) + "% against its own line in <code>" + L.check.file + "</code>:",
      "Прогоните сами — скрипт заодно не пропускает регрессию p95 больше " +
        (L.check.tolerance * 100) + "% относительно своей линии в <code>" + L.check.file + "</code>:", "p"));
    how.appendChild(cmd(L.command));
    how.appendChild(table(
      [["operation", "операция"], ["p50, ms", "p50, мс"], ["p95, ms", "p95, мс"], ["p99, ms", "p99, мс"], ["budget", "бюджет"], ["n", "n"]],
      L.rows.map(function (r) {
        return [bi(r.label_en, r.label_ru), num(r.p50, 3), num(r.p95, 3), num(r.p99, 3), String(r.budget), String(r.n)];
      }), 1));
    how.appendChild(bi(
      "Conditions travel with the number: " + L.corpus_en + ", machine " + (D.latency.env || D.env).machine +
        ". A percentage taken on other hardware would mean nothing, so the baseline file is split per machine.",
      "Условия едут вместе с числом: " + L.corpus_ru + ", машина " + (D.latency.env || D.env).machine +
        ". Процент, снятый на другом железе, не значит ничего, поэтому файл линии разложен по машинам.", "p"));
  })();

  // ── 03 ранжирование ────────────────────────────────────────────────────────
  function groupedChart(host, groups, series, fmt) {
    var wrap = el("div", { class: "rows" });
    groups.forEach(function (g) {
      var row = el("div", { class: "row" });
      var lab = el("div", { class: "rl" });
      lab.appendChild(bi(g.label_en, g.label_ru));
      if (g.control) {
        var tag = el("span", { class: "tag" });
        tag.appendChild(bi("control ↓", "контроль ↓"));
        lab.appendChild(el("br"));
        lab.appendChild(tag);
      }
      row.appendChild(lab);
      var bars = el("div", { class: "bars" });
      series.forEach(function (s, i) {
        var v = g[s.key];
        var line = el("div", { class: "bar-line" });
        // Нулевое значение обязано быть НУЛЁМ на экране: минимальная ширина
        // полосы делает из нуля видимую засечку, а это уже не то число.
        line.appendChild(el("div", { class: "track" },
          el("div", { class: "fill" + (v > 0 ? "" : " zero"), style: "width:" + Math.max(0, v * 100).toFixed(1) + "%;background:" + s.color,
            "data-tip": s.en + " · " + g.label_en + ": " + fmt(v) })));
        var showLabel = i === series.length - 1 || g.control;
        line.appendChild(el("span", { class: "bar-val", text: showLabel ? fmt(v) : "" }));
        bars.appendChild(line);
      });
      row.appendChild(bars);
      wrap.appendChild(row);
    });
    host.appendChild(legend(series));
    host.appendChild(wrap);
  }

  (function () {
    var B = D.boost;
    document.getElementById("boost-sub").appendChild(bi(
      "MRR@10 per query group. Corpus: " + B.corpus.nodes + " nodes, " + B.corpus.queries + " queries, vector branch off. Overall <strong>" + num(B.overall.off.mrr, 3) + " → " + num(B.overall.on.mrr, 3) + "</strong>.",
      "MRR@10 по группам запросов. Корпус: " + B.corpus.nodes + " узлов, " + B.corpus.queries + " запросов, векторная ветка выключена. В целом <strong>" + num(B.overall.off.mrr, 3) + " → " + num(B.overall.on.mrr, 3) + "</strong>."));
    groupedChart(document.getElementById("boost-chart"), B.groups,
      [{ key: "off", color: STEP[0], en: "boosts off", ru: "бусты выключены" },
       { key: "on", color: STEP[1], en: "boosts on", ru: "бусты включены" }],
      function (v) { return num(v, 3); });

    var how = document.getElementById("boost-how");
    how.appendChild(cmd(B.command));
    how.appendChild(table(
      [["group", "группа"], ["MRR@10 off", "MRR@10 без"], ["MRR@10 on", "MRR@10 с"], ["delta", "дельта"]],
      B.groups.map(function (g) {
        var d = g.on - g.off;
        return [bi(g.label_en, g.label_ru), num(g.off, 3), num(g.on, 3),
          el("span", { class: d < 0 ? "lose" : "", text: (d >= 0 ? "+" : "") + num(d, 3) })];
      }).concat([[bi("<strong>overall</strong>", "<strong>в целом</strong>"), num(B.overall.off.mrr, 3), num(B.overall.on.mrr, 3),
        "+" + num(B.overall.on.mrr - B.overall.off.mrr, 3)]]), 1));
    how.appendChild(bi("P@1 moves " + num(B.overall.off.p1, 3) + " → " + num(B.overall.on.p1, 3) + " over the same " + B.corpus.queries + " queries.",
      "P@1 меняется " + num(B.overall.off.p1, 3) + " → " + num(B.overall.on.p1, 3) + " на тех же " + B.corpus.queries + " запросах.", "p"));
  })();

  (function () {
    var G = D.graph;
    document.getElementById("graph-sub").appendChild(bi(
      "MRR@10 per query group. Corpus: " + G.corpus.nodes + " nodes, " + G.corpus.edges + " edges, " + G.corpus.queries + " queries. Overall <strong>" + num(G.overall.off.mrr, 3) + " → " + num(G.overall.hop2.mrr, 3) + "</strong>; answers found <strong>" + G.overall.off.found + " → " + G.overall.hop2.found + "</strong> of " + G.total_queries + ".",
      "MRR@10 по группам запросов. Корпус: " + G.corpus.nodes + " узлов, " + G.corpus.edges + " рёбер, " + G.corpus.queries + " запросов. В целом <strong>" + num(G.overall.off.mrr, 3) + " → " + num(G.overall.hop2.mrr, 3) + "</strong>; ответов найдено <strong>" + G.overall.off.found + " → " + G.overall.hop2.found + "</strong> из " + G.total_queries + "."));
    groupedChart(document.getElementById("graph-chart"), G.groups,
      [{ key: "off", color: STEP[0], en: "no expansion", ru: "без обхода" },
       { key: "hop1", color: STEP[1], en: "1 hop", ru: "1 хоп" },
       { key: "hop2", color: STEP[2], en: "2 hops", ru: "2 хопа" }],
      function (v) { return num(v, 3); });

    var how = document.getElementById("graph-how");
    how.appendChild(cmd(G.command));
    how.appendChild(table(
      [["group", "группа"], ["off", "без"], ["1 hop", "1 хоп"], ["2 hops", "2 хопа"]],
      G.groups.map(function (g) {
        return [bi(g.label_en, g.label_ru), num(g.off, 3), num(g.hop1, 3),
          el("span", { class: g.control ? "lose" : "", text: num(g.hop2, 3) })];
      }), 1));
    how.appendChild(bi(
      "The two-hop group is the one that cannot be reached in a single hop: " + num(G.groups[1].hop1, 3) + " → " + num(G.groups[1].hop2, 3) + ". The purely lexical group is untouched at " + num(G.groups[3].off, 3) + " across all three variants — expansion adds reach without disturbing what already worked.",
      "Группа «два хопа» — та, до которой в один хоп не добраться: " + num(G.groups[1].hop1, 3) + " → " + num(G.groups[1].hop2, 3) + ". Чисто лексическая группа не тронута — " + num(G.groups[3].off, 3) + " во всех трёх вариантах: обход добавляет охват, не трогая того, что и так работало.", "p"));
  })();

  (function () {
    var bc = D.boost.groups.filter(function (g) { return g.control; })[0];
    var gc = D.graph.groups.filter(function (g) { return g.control; })[0];
    var host = document.getElementById("control-stats");
    [[bc.off, bc.on, "boost corpus", "корпус бустов", D.boost.command],
     [gc.off, gc.hop2, "graph corpus", "корпус графа", D.graph.command]].forEach(function (r) {
      var card = el("div", { class: "card", style: "border-left:2px solid var(--warning)" },
        statTile(num(r[0], 3) + " → " + num(r[1], 3), "MRR@10",
          "distractor group, " + r[2] + " — <strong>drops by " + num(r[0] - r[1], 3) + "</strong>",
          "группа дистракторов, " + r[3] + " — <strong>падает на " + num(r[0] - r[1], 3) + "</strong>",
          "this is the expected direction", "это ожидаемое направление"));
      card.appendChild(el("div", { style: "margin-top:.9rem" }, cmd(r[4])));
      host.appendChild(card);
    });
  })();

  // ── 04 кеш ─────────────────────────────────────────────────────────────────
  (function () {
    var C = D.cache;
    var LO = -4, HI = 2;                       // 0.0001 мс … 100 мс
    function posOf(v) { return ((Math.log(v) / Math.LN10) - LO) / (HI - LO) * 100; }

    document.getElementById("cache-sub").appendChild(bi(
      "Milliseconds on a <strong>logarithmic</strong> axis — on a linear one the hit would be invisible, which is true but unreadable.",
      "Миллисекунды по <strong>логарифмической</strong> оси — на линейной попадание было бы не видно: правдиво, но нечитаемо."));

    var host = document.getElementById("cache-chart");
    host.appendChild(legend([
      { color: STEP[2], en: "miss", ru: "промах" },
      { color: STEP[0], en: "hit", ru: "попадание" }]));

    // Полотно во всю ширину карточки: линии сетки, полосы и ось меряются от
    // одного левого края, иначе засечка оси показывала бы не туда, куда
    // кончается полоса.
    var plot = el("div", { class: "logplot" });
    for (var d = LO; d <= HI; d++) plot.appendChild(el("div", { class: "gl", style: "left:" + posOf(Math.pow(10, d)) + "%" }));

    C.rows.forEach(function (r) {
      var head = el("div", { class: "logrow-head" });
      head.appendChild(el("span", null)).appendChild(bi(r.label_en, r.label_ru));
      var ratio = el("strong", { class: "ratio" });
      ratio.appendChild(bi("×" + group(r.ratio) + " cheaper", "×" + group(r.ratio) + " дешевле"));
      head.appendChild(ratio);
      plot.appendChild(head);

      [[r.miss_ms, STEP[2], "miss", "промах"], [r.hit_ms, STEP[0], "hit", "попадание"]].forEach(function (b) {
        var w = posOf(b[0]);
        var lane = el("div", { class: "logbar" },
          el("div", { class: "logfill", style: "width:" + w.toFixed(2) + "%;background:" + b[1], "data-tip": b[2] + ": " + b[0] + " ms" }));
        var inside = w > 72;
        lane.appendChild(el("span", {
          class: "logval" + (inside ? " inside" : ""),
          style: (inside ? "right:calc(100% - " + w.toFixed(2) + "% + .45rem)" : "left:calc(" + w.toFixed(2) + "% + .45rem)"),
          text: b[0] + " ms"
        }));
        plot.appendChild(lane);
      });
    });

    var axis = el("div", { class: "logaxis" });
    for (var k = LO; k <= HI; k++) {
      axis.appendChild(el("span", { class: "tick", style: "left:" + posOf(Math.pow(10, k)) + "%", text: String(Math.pow(10, k)) }));
    }
    plot.appendChild(axis);
    host.appendChild(plot);
    host.appendChild(el("div", { class: "muted", style: "font-size:.72rem;margin-top:.1rem" })).appendChild(
      bi("milliseconds, log₁₀ scale", "миллисекунды, шкала log₁₀"));

    var how = document.getElementById("cache-how");
    how.appendChild(cmd(C.command));
    how.appendChild(table(
      [["path", "путь"], ["miss, ms", "промах, мс"], ["hit, ms", "попадание, мс"], ["ratio", "во сколько раз"]],
      C.rows.map(function (r) { return [bi(r.label_en, r.label_ru), String(r.miss_ms), String(r.hit_ms), "×" + group(r.ratio)]; }), 1));
    how.appendChild(bi(
      "The test prints the ratio from unrounded timings; the site records the times exactly as printed, and <code>site/build.ts</code> checks that the ratio lies inside the interval that this printed precision allows. Memory cost on the process: " + C.memory.search_mib + " MiB for " + C.memory.search_entries + " cached answers plus " + C.memory.embed_mib + " MiB for " + C.memory.embed_entries + " cached vectors. " + C.tests.pass + " tests pass in this file, " + C.tests.fail + " fail.",
      "Тест печатает отношение по неокруглённым временам; сайт хранит времена ровно так, как они напечатаны, а <code>site/build.ts</code> проверяет, что отношение лежит внутри интервала, допустимого этой напечатанной точностью. Память на процесс: " + C.memory.search_mib + " МиБ на " + C.memory.search_entries + " закешированных ответов плюс " + C.memory.embed_mib + " МиБ на " + C.memory.embed_entries + " закешированных векторов. Тестов в этом файле: " + C.tests.pass + " прошло, " + C.tests.fail + " упало.", "p"));

    var hh = document.getElementById("hitrate-chart");
    C.hitrate.forEach(function (h) {
      var row = el("div", { class: "row" });
      var lab = el("div", { class: "rl" }); lab.appendChild(bi(h.label_en, h.label_ru)); row.appendChild(lab);
      var line = el("div", { class: "bar-line" },
        el("div", { class: "track" }, el("div", { class: "fill", style: "width:" + (h.hits / h.of * 100).toFixed(1) + "%;background:" + SERIES, "data-tip": h.hits + " / " + h.of })),
        el("span", { class: "bar-val", text: h.hits + "/" + h.of + " · " + Math.round(h.hits / h.of * 100) + "%" }));
      row.appendChild(line);
      hh.appendChild(row);
    });

    var ci = document.getElementById("cache-identical");
    ci.appendChild(el("div", { class: "stat" },
      el("div", { class: "v tnum", text: String(D.graph.cache.rank_mismatches) })));
    ci.appendChild(bi(
      "ranks moved between the cached and the uncached run of the same " + D.graph.corpus.queries + " queries (" + D.graph.cache.hits + " hits, " + D.graph.cache.misses + " misses). Matching averages could be produced by shuffling the output; matching <em>ranks</em> could not.",
      "рангов разошлось между прогоном с кешем и без него на тех же " + D.graph.corpus.queries + " запросах (" + D.graph.cache.hits + " попаданий, " + D.graph.cache.misses + " промахов). Совпадение средних можно получить, перемешав выдачу; совпадение <em>рангов</em> — нельзя.", "p"));
    ci.appendChild(cmd(D.cache.ranking_note_command));
  })();

  // ── 05 миграция ────────────────────────────────────────────────────────────
  (function () {
    var I = D.import;
    I.rows.forEach(function (r) {
      put("import-stats", el("div", { class: "card" }, statTile(group(r.n), null, r.label_en, r.label_ru)));
    });
    put("import-stats", el("div", { class: "card" }, statTile(group(I.ms), "ms",
      "total, into an empty workspace", "всего, в пустой воркспейс",
      "wall clock of one run, " + D.env.date + ", myc " + D.env.myc, "стенное время одного прогона, " + D.env.date + ", myc " + D.env.myc)));
    put("import-stats", el("div", { class: "card" }, statTile("0", null,
      "dependencies with a missing target", "зависимостей без цели",
      "and 0 rows refused", "и 0 строк не ввезено")));

    var w = document.getElementById("import-warn");
    w.appendChild(bi("<strong>Two anomalies were named, not swallowed:</strong>", "<strong>Две аномалии названы, а не проглочены:</strong>", "p"));
    var ul = el("ul", { class: "warn-list" });
    I.warnings.forEach(function (x) {
      var li = el("li");
      li.appendChild(bi(x.en, x.ru));
      ul.appendChild(li);
    });
    w.appendChild(ul);

    var how = document.getElementById("import-how");
    how.appendChild(bi("Take a snapshot out of the beads project:", "Снимите снимок из проекта на beads:", "p"));
    how.appendChild(cmd(I.prep_command));
    how.appendChild(bi("Then import it into an empty myc workspace:", "Потом ввезите его в пустой воркспейс myc:", "p"));
    how.appendChild(cmd(I.command));
    how.appendChild(bi("Target: " + I.target_en + ".", "Цель: " + I.target_ru + ".", "p"));

    // Текст следует данным: пока очереди расходились, здесь честно стояло
    // «не закрыто», и после исправления (0.2.0) оно простояло на сайте до 0.3.6.
    var g = I.ready_gap;
    var rg = document.getElementById("ready-gap");
    if (g.diff === 0 && g.issue_closed) {
      rg.appendChild(bi(
        "On the very graph imported above <code>myc ready</code> offers <strong>" + g.myc + "</strong> tasks and <code>bd ready</code> offers <strong>" + g.bd + "</strong>: <strong>the queues agree now, and did not always.</strong> Beads inherits blockers down the parent chain, and myc used to look only at a task's own — so there <em>beads was right</em>. Fixed in 0.2.0 (<code>" + g.issue_closed + "</code>). " + g.note_en,
        "На том же ввезённом графе <code>myc ready</code> предлагает <strong>" + g.myc + "</strong> задач, а <code>bd ready</code> — <strong>" + g.bd + "</strong>: <strong>очереди совпадают — но совпадали не всегда.</strong> Beads наследует блокеры вниз по цепочке parent, а myc смотрел только на собственные блокеры задачи, — и там <em>прав был beads</em>. Исправлено в 0.2.0 (<code>" + g.issue_closed + "</code>). " + g.note_ru, "p"));
    } else {
      rg.appendChild(bi(
        "On the very graph imported above, <code>myc ready</code> offers <strong>" + g.myc + "</strong> tasks and <code>bd ready</code> offers <strong>" + g.bd + "</strong> — a difference of <strong>" + g.diff + "</strong>. Tracked as <code>" + g.issue + "</code>, unresolved.",
        "На том же ввезённом графе <code>myc ready</code> предлагает <strong>" + g.myc + "</strong> задач, а <code>bd ready</code> — <strong>" + g.bd + "</strong>: расхождение <strong>" + g.diff + "</strong>. Заведено как <code>" + g.issue + "</code>, не закрыто.", "p"));
    }
    var pair = el("div", { class: "grid-2", style: "margin-top:1rem" });
    pair.appendChild(el("div", null, cmd(g.myc_command), el("div", { class: "muted", style: "font-size:.78rem;margin-top:.3rem", text: "ready: " + g.myc })));
    pair.appendChild(el("div", null, cmd(g.bd_command), el("div", { class: "muted", style: "font-size:.78rem;margin-top:.3rem", text: "ready: " + g.bd })));
    rg.appendChild(pair);
  })();

  // ── 02 что умеет ───────────────────────────────────────────────────────────
  (function () {
    var F = D.features;
    var counts = {}, order = [], total = 0;
    F.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        if (!(it.since in counts)) { counts[it.since] = 0; order.push(it.since); }
        counts[it.since]++;
        total++;
      });
    });
    order.sort(cmpVer);
    var strip = document.getElementById("feature-releases");
    strip.appendChild(bi(
      total + " lines in " + F.groups.length + " groups; how many arrived in each release:",
      total + " строк в " + F.groups.length + " группах; сколько пришло в каждом релизе:", "p"));
    var chips = el("div", { class: "chips" });
    order.forEach(function (v) {
      chips.appendChild(el("span", { class: "chip", "data-tip": v + ": " + counts[v] },
        el("span", { class: "since", text: v }), el("span", { class: "tnum", text: "×" + counts[v] })));
    });
    strip.appendChild(chips);

    var host = document.getElementById("feature-groups");
    F.groups.forEach(function (g) {
      var card = el("div", { class: "card fgroup", id: "f-" + g.key });
      card.appendChild(el("h3")).appendChild(bi(g.title_en, g.title_ru));
      var ul = el("ul", { class: "flist" });
      g.items.forEach(function (it) {
        var body = el("div", { class: "fbody" });
        body.appendChild(bi(it.en, it.ru, "div"));
        body.appendChild(el("code", { class: "fcmd", text: it.cmd }));
        ul.appendChild(el("li", null, el("span", { class: "since", text: it.since }), body));
      });
      card.appendChild(ul);
      host.appendChild(card);
    });
  })();

  // ── 09 чего нет: числа вех — из того же снимка, что и дорожная карта ──────
  // Раньше здесь стояло «M3 стоит на 5 из 10» текстом, пока дорожная карта
  // уже показывала 6 из 10: два места для одного числа расходятся молча.
  (function () {
    var byKey = {};
    D.roadmap.rows.forEach(function (r) { byKey[r.key] = r; });
    var m3 = byKey.M3, m5 = byKey.M5, m6 = byKey.M6;
    if (m3) put("absent-code", bi(
      "No LLM pass over the code: no concept map, no per-symbol prose. The index is mechanical — definitions, references, spans. M3 stands at " + m3.done + " of " + m3.total + ".",
      "Нет прохода модели по коду: ни концептуальной карты, ни выжимок по символам. Индекс механический — определения, ссылки, спаны. M3 стоит на " + m3.done + " из " + m3.total + "."));
    if (m5 && m6) {
      var none = m5.done === 0 && m6.done === 0;
      put("absent-swarm", bi(
        "No routing by cost and outcome, and no distillation: M5 stands at " + m5.done + " of " + m5.total + ", M6 at " + m6.done + " of " + m6.total + (none ? " — neither has started" : "") + ". Attempts and model prices are recorded; nothing picks a model for you.",
        "Нет роутинга по цене и результату и нет дистилляции: M5 стоит на " + m5.done + " из " + m5.total + ", M6 — на " + m6.done + " из " + m6.total + (none ? ", не начата ни одна" : "") + ". Попытки и цены моделей записываются; модель за вас не выбирает ничто."));
    }
  })();

  // ── 10 дорожная карта и планы ──────────────────────────────────────────────
  (function () {
    var R = D.roadmap;
    var byId = {};
    R.rows.forEach(function (r) { byId[r.id] = r; });
    var started = R.rows.filter(function (r) { return r.done > 0; }).length;
    var src = String(R.source).split(" · ")[0];
    document.getElementById("roadmap-sub").appendChild(bi(
      "Closed tasks per epic, counted from myc on " + R.as_of + " (" + src + ") — the figure <code>myc show &lt;epic&gt;</code> prints. " + (R.rows.length - started) + " of " + R.rows.length + " have not started at all. A sub-epic counts as one task of its parent and has its own row.",
      "Закрытые задачи по эпикам, посчитанные из myc на " + R.as_of + " (" + src + "), — то число, что печатает <code>myc show &lt;эпик&gt;</code>. " + (R.rows.length - started) + " из " + R.rows.length + " не начаты вовсе. Под-эпик считается у родителя одной задачей и получает свою строку."));

    var host = document.getElementById("roadmap");
    R.rows.forEach(function (r) {
      var share = r.total ? r.done / r.total : 0;
      var parent = r.parent ? byId[r.parent] : null;
      var m = el("div", { class: "milestone" + (parent ? " sub" : "") }, el("div", { class: "mk", text: r.key }));
      var right = el("div");
      var t = el("div", { class: "mt" });
      t.appendChild(bi(r.title_en + (parent ? " <span class=\"muted\">· part of " + parent.key + "</span>" : ""),
        r.title_ru + (parent ? " <span class=\"muted\">· часть " + parent.key + "</span>" : "")));
      right.appendChild(t);
      var rest = r.total - r.done;
      var mn = el("div", { class: "mn" });
      mn.appendChild(el("span", { class: rest === 0 ? "all" : "", text: String(r.done) }));
      mn.appendChild(document.createTextNode(" / " + r.total));
      right.appendChild(el("div", { class: "mbar" },
        el("div", { class: "track" }, el("div", { class: "fill" + (r.done > 0 ? "" : " zero"), style: "width:" + (share * 100).toFixed(1) + "%;background:" + SERIES, "data-tip": r.key + ": " + r.done + " / " + r.total + " (" + Math.round(share * 100) + "%)" })),
        mn));
      // «Не сделано» набрано тем же кеглем и той же краской, что и «сделано»:
      // веха, стоящая на нуле, обязана читаться так же ясно, как закрытая.
      var left = el("div", { class: "mrest" });
      if (rest === 0) left.appendChild(bi("all closed", "закрыта целиком"));
      else {
        left.appendChild(el("strong", { text: String(rest) }));
        left.appendChild(document.createTextNode(" "));
        left.appendChild(bi("not done", "не сделано"));
      }
      if (r.in_progress > 0) left.appendChild(bi(" · " + r.in_progress + " in progress", " · в работе: " + r.in_progress));
      // Эпик и его задачи закрываются отдельно — и сайт говорит, какое из двух.
      if (r.status === "closed" && rest > 0) left.appendChild(bi(" · the epic itself is closed", " · сам эпик закрыт"));
      if (r.status !== "closed" && rest === 0) left.appendChild(bi(" · the epic itself is still open", " · сам эпик ещё открыт"));
      left.appendChild(el("span", { class: "muted", style: "font-family:var(--mono);font-weight:400", text: "  ·  " + r.id }));
      right.appendChild(left);
      m.appendChild(right);
      host.appendChild(m);
    });

    var how = document.getElementById("roadmap-how");
    how.appendChild(bi("All rows at once, rewritten into <code>site/measurements.json</code> — run before a release, like the benchmarks:",
      "Все строки разом, с перезаписью <code>site/measurements.json</code>, — запускается перед релизом, как бенчмарки:", "p"));
    how.appendChild(cmd(R.command));
    how.appendChild(bi("Each row is one command against the live workspace:", "Каждая строка — одна команда к живому воркспейсу:", "p"));
    R.rows.forEach(function (r) { how.appendChild(cmd("myc show " + r.id)); });

    // Планы: КАЖДАЯ незакрытая задача снимка. Описание на сайте есть не у всех
    // обязательно — у кого нет, та показана заголовком из трекера, но показана:
    // прятать открытую работу нельзя. Обратное (описание уже закрытой задачи)
    // не пропускает site/build.ts.
    var desc = {}, epicNote = {};
    D.planned.epics.forEach(function (e) {
      epicNote[e.id] = e;
      e.items.forEach(function (it) { desc[it.id] = it; });
    });
    var ph = document.getElementById("planned-epics");
    R.rows.forEach(function (r) {
      if (r.open.length === 0) return;
      var parent = r.parent ? byId[r.parent] : null;
      var card = el("div", { class: "card pepic", id: "plan-" + r.key });
      var head = el("div", { class: "phead" }, el("span", { class: "mk", text: r.key }));
      head.appendChild(el("h3")).appendChild(bi(r.title_en, r.title_ru));
      card.appendChild(head);
      var state = el("div", { class: "pstate" });
      if (r.status === "closed") {
        state.appendChild(bi("epic closed · " + r.done + " of " + r.total + " tasks closed", "эпик закрыт · закрыто " + r.done + " из " + r.total));
      } else if (r.done === 0 && r.in_progress === 0) {
        state.appendChild(bi("not started · 0 of " + r.total + " closed", "не начато · закрыто 0 из " + r.total));
        state.className += " none";
      } else {
        state.appendChild(bi(r.done + " of " + r.total + " closed · " + (r.in_progress > 0 ? r.in_progress + " in progress" : "nothing in progress right now"),
          "закрыто " + r.done + " из " + r.total + " · " + (r.in_progress > 0 ? "в работе: " + r.in_progress : "сейчас в работе ничего")));
      }
      if (parent) state.appendChild(bi(" · part of " + parent.key, " · часть " + parent.key));
      card.appendChild(state);
      var note = epicNote[r.id];
      if (note && note.en) card.appendChild(bi(note.en, note.ru, "p"));
      var ul = el("ul", { class: "plist" });
      r.open.forEach(function (c) {
        var body = el("div");
        var d = desc[c.id];
        if (d) body.appendChild(bi(d.en, d.ru, "div"));
        else body.appendChild(bi(esc(c.title) + " <span class=\"muted\">(title as in the tracker)</span>", esc(c.title) + " <span class=\"muted\">(заголовок из трекера)</span>", "div"));
        var meta = el("div", { class: "pmeta" }, el("code", { text: c.id }), document.createTextNode(" · "));
        meta.appendChild(c.status === "in_progress" ? bi("in progress", "в работе") : bi("open, not taken", "открыта, никем не взята"));
        body.appendChild(meta);
        ul.appendChild(el("li", null, el("span", { class: "prio", text: "P" + c.priority }), body));
      });
      card.appendChild(ul);
      card.appendChild(el("div", { style: "margin-top:.9rem" }, cmd("myc show " + r.id)));
      ph.appendChild(card);
    });
  })();

  // ── 11 повторить ───────────────────────────────────────────────────────────
  (function () {
    var list = [
      { en: "latency budgets on 100 000 nodes", ru: "бюджеты латентности на 100 000 узлов", c: D.latency.command },
      { en: "ranking: boosts", ru: "ранжирование: бусты", c: D.boost.command },
      { en: "ranking: graph expansion", ru: "ранжирование: обход графа", c: D.graph.command },
      { en: "cache: price of a hit", ru: "кеш: цена попадания", c: D.cache.command },
      { en: "package size and file count", ru: "размер пакета и число файлов", c: D.package.command },
      { en: "snapshot out of a beads project", ru: "снимок из проекта на beads", c: D.import.prep_command },
      { en: "import it", ru: "ввезти его", c: D.import.command },
      { en: "the two ready queues, side by side", ru: "две очереди готовых задач рядом", c: D.import.ready_gap.myc_command + "   #   " + D.import.ready_gap.bd_command },
      { en: "milestone counts and open tasks, from myc (needs this repository's workspace)", ru: "счёт по вехам и открытые задачи — из myc (нужен воркспейс этого репозитория)", c: D.roadmap.command },
      { en: "the whole test suite", ru: "весь прогон тестов", c: D.tests.command },
      { en: "re-verify this page against the repository", ru: "пересверить эту страницу с репозиторием", c: "bun run site/build.ts" }
    ];
    var host = document.getElementById("commands");
    list.forEach(function (x) {
      var block = el("div", { style: "margin-bottom:1rem" });
      var cap = el("div", { class: "muted", style: "font-size:.78rem;margin-bottom:.3rem" });
      cap.appendChild(bi(x.en, x.ru));
      block.appendChild(cap);
      block.appendChild(cmd(x.c));
      host.appendChild(block);
    });

    var T = D.tests;
    var th = document.getElementById("tests");
    var row = el("div", { class: "grid-3", style: "margin-bottom:1.2rem" });
    row.appendChild(el("div", null, statTile(group(T.pass), null, "tests pass", "тестов проходит", T.assertions ? group(T.assertions) + " assertions, " + T.files + " files" : null, group(T.assertions) + " проверок, " + T.files + " файлов")));
    row.appendChild(el("div", null, statTile(String(T.fail), null, T.fail === 1 ? "test fails" : "tests fail", T.fail === 1 ? "тест падает" : "тестов падает",
      T.fail > 0 ? "named below" : "myc " + T.myc + ", " + T.date, T.fail > 0 ? "назван ниже" : "myc " + T.myc + ", " + T.date)));
    row.appendChild(el("div", null, statTile(String(T.skip), null, "skipped", "пропущено", T.seconds + " s wall clock", T.seconds + " с стенного времени")));
    th.appendChild(row);
    th.appendChild(cmd(T.command));
    // Падение называется по имени; без падения красной плашки нет. Раньше она
    // рисовалась всегда — и при нуле падений показывала «undefined».
    var note = el("div", { style: "margin-top:1rem;border-left:2px solid var(" + (T.fail > 0 ? "--critical" : "--good") + ");padding-left:1rem" });
    if (T.fail > 0) {
      note.appendChild(el("code", { text: T.failing_test, style: "display:block;margin-bottom:.5rem" }));
      note.appendChild(bi(T.failing_note_en, T.failing_note_ru, "p"));
    } else {
      note.appendChild(bi(
        "The snapshot carries a fingerprint of the sources it ran on (<code>" + T.sources + "</code>), and <code>site/build.ts</code> refuses it as soon as the code changes — the count cannot quietly outlive the code it describes.",
        "Снимок несёт отпечаток исходников, на которых снят (<code>" + T.sources + "</code>), и <code>site/build.ts</code> отказывает ему, как только код изменился, — число не может тихо пережить код, о котором оно.", "p"));
    }
    th.appendChild(note);
  })();

  // ── переключатели, копирование, подсказки ──────────────────────────────────
  var root = document.documentElement;

  function setLang(lang, keepPlace) {
    // Ничего не перерисовываем и никуда не переходим: обе языковые половины уже
    // в DOM, CSS показывает нужную. Но текст на двух языках разной длины, и всё,
    // что выше по странице, меняет высоту — читателя утащило бы на пару экранов.
    // Поэтому запоминаем ЯКОРЬ: ближайший к верху заголовок и его смещение от
    // края окна, и после смены возвращаем его на то же место.
    var anchor = null;
    if (keepPlace) {
      var marks = document.querySelectorAll("section, .card, h2, h3");
      for (var i = 0; i < marks.length; i++) {
        var r = marks[i].getBoundingClientRect();
        if (r.bottom > 0) { anchor = { node: marks[i], top: r.top }; break; }
      }
    }
    root.setAttribute("data-lang", lang);
    root.setAttribute("lang", lang);
    try { localStorage.setItem("myc-lang", lang); } catch (e) {}
    // replaceState не трогает прокрутку — в отличие от перехода по ссылке.
    // Под file:// он в некоторых браузерах бросает SecurityError; язык от этого
    // страдать не должен, поэтому адрес обновляется по возможности.
    try {
      var url = new URL(location.href);
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url);
    } catch (e) {}
    document.querySelectorAll("[data-lang-btn]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang-btn") === lang));
    });
    if (anchor) {
      var prev = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";  // без анимации: это не переход
      window.scrollTo(0, Math.max(0, window.scrollY + anchor.node.getBoundingClientRect().top - anchor.top));
      document.documentElement.style.scrollBehavior = prev;
    }
  }
  document.querySelectorAll("[data-lang-btn]").forEach(function (b) {
    b.addEventListener("click", function () { setLang(b.getAttribute("data-lang-btn"), true); });
  });
  setLang(root.getAttribute("data-lang") || "en");

  document.getElementById("theme-btn").addEventListener("click", function () {
    var cur = root.getAttribute("data-theme");
    var isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    var next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("myc-theme", next); } catch (e) {}
  });

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".copy");
    if (!b) return;
    var code = b.parentNode.querySelector("code");
    if (!code) return;
    var done = function () {
      b.setAttribute("data-done", "1");
      b.textContent = root.getAttribute("data-lang") === "ru" ? "скопировано" : "copied";
      setTimeout(function () { b.removeAttribute("data-done"); b.textContent = "copy"; }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(code.textContent).then(done, function () {});
    else {
      var r = document.createRange(); r.selectNodeContents(code);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      try { document.execCommand("copy"); done(); } catch (err) {}
    }
  });

  var tip = document.getElementById("tip");
  document.addEventListener("mouseover", function (e) {
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) return;
    tip.textContent = t.getAttribute("data-tip");
    var r = t.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - 8, Math.max(8, r.left + r.width / 2)) + "px";
    tip.style.top = r.top + "px";
    tip.setAttribute("data-on", "1");
  });
  document.addEventListener("mouseout", function (e) {
    if (e.target.closest && e.target.closest("[data-tip]")) tip.removeAttribute("data-on");
  });
})();
