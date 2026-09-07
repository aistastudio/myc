import { describe, expect, test } from "bun:test";
import { Diagnostics } from "./diagnostics.ts";
import {
  renderDataHuman,
  renderErrorHuman,
  renderTable,
  renderValue,
  renderWarnLines,
} from "./render.ts";

describe("renderValue", () => {
  test("primitives and nested values", () => {
    expect(renderValue(null)).toBe("null");
    expect(renderValue("x")).toBe("x");
    expect(renderValue(5)).toBe("5");
    expect(renderValue(true)).toBe("true");
    expect(renderValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("renderTable", () => {
  test("dense columns, widths from actual data, last column unpadded", () => {
    const text = renderTable(
      ["id", "status"],
      [
        ["myc-a3f8", "open"],
        ["myc-b1c2", "in_progress"],
      ],
      false,
    );
    expect(text).toBe(
      "ID        STATUS\nmyc-a3f8  open\nmyc-b1c2  in_progress\n",
    );
  });

  test("color bolds the header only when enabled", () => {
    const rows = [["a"]];
    const plain = renderTable(["k"], rows, false);
    const color = renderTable(["k"], rows, true);
    expect(plain).toBe("K\na\n");
    expect(color).toBe("\x1b[1mK\x1b[0m\na\n");
  });

  test("empty cell for missing values, no trailing spaces", () => {
    const text = renderTable(
      ["id", "s"],
      [
        ["a", "x"],
        ["b", ""],
      ],
      false,
    );
    expect(text).toBe("ID  S\na   x\nb\n");
  });
});

describe("renderDataHuman", () => {
  test("null prints nothing", () => {
    expect(renderDataHuman(null, false)).toBe("");
  });

  test("scalar string", () => {
    expect(renderDataHuman("added", false)).toBe("added\n");
  });

  test("list of primitives: one per line", () => {
    expect(renderDataHuman([1, "two", true], false)).toBe("1\ntwo\ntrue\n");
  });

  test("list of objects: snapshot of the dense table", () => {
    const text = renderDataHuman(
      [
        { id: "myc-a3f8", status: "in_progress", title: "CLI skeleton" },
        { id: "myc-b1c2", status: "open", title: "Wire store" },
      ],
      false,
    );
    expect(text).toBe(
      "ID        STATUS       TITLE\n" +
        "myc-a3f8  in_progress  CLI skeleton\n" +
        "myc-b1c2  open         Wire store\n",
    );
  });

  test("single object: key/value lines", () => {
    expect(renderDataHuman({ id: "myc-a3f8", n: 3 }, false)).toBe(
      "id  myc-a3f8\nn   3\n",
    );
  });

  test("iterables are materialized for the table", () => {
    function* items() {
      yield { id: "a" };
      yield { id: "b" };
    }
    expect(renderDataHuman(items(), false)).toBe("ID\na\nb\n");
  });

  test("empty list prints nothing", () => {
    expect(renderDataHuman([], false)).toBe("");
  });
});

describe("renderWarnLines", () => {
  test("one WARN line per diagnostic", () => {
    const diags = new Diagnostics();
    diags.add("index.partial", "3 anchors stale");
    diags.add("embed.fallback", "model file missing");
    expect(renderWarnLines(diags, false)).toBe(
      "WARN index.partial: 3 anchors stale\nWARN embed.fallback: model file missing\n",
    );
  });

  test("yellow when color, nothing when empty", () => {
    const diags = new Diagnostics();
    diags.add("a.b", "m");
    expect(renderWarnLines(diags, true)).toBe("\x1b[33mWARN a.b: m\x1b[0m\n");
    expect(renderWarnLines(new Diagnostics(), true)).toBe("");
  });
});

describe("renderErrorHuman", () => {
  test("error line, hint, warn block", () => {
    const diags = new Diagnostics();
    diags.add("a.b", "m");
    const text = renderErrorHuman(
      { code: "conflict.claimed", msg: "myc-a3f8 taken", hint: "myc claim myc-a3f8 --steal" },
      diags,
      false,
    );
    expect(text).toBe(
      "myc: conflict.claimed: myc-a3f8 taken\n" +
        "  hint: myc claim myc-a3f8 --steal\n" +
        "WARN a.b: m\n",
    );
  });
});
