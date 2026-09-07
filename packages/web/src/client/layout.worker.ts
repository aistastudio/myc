/// <reference lib="webworker" />
/**
 * Лэйаут графа в Web Worker.
 *
 * Почему воркер, а не главный поток: 10k узлов × 300 итераций — это секунды
 * счёта, и в главном потоке они превращаются в замерший интерфейс. Здесь же
 * главный поток только рисует то, что уже посчитано.
 *
 * Две фазы, и это ключ к бюджету «первый кадр < 400 мс»:
 *
 *   1. ЗАСЕВ — детерминированная раскладка за один проход O(n): виды идут
 *      кластерами по окружности, внутри кластера узлы ложатся по спирали
 *      Фибоначчи в порядке убывания степени. На 10k это ~3 мс. Кадр рисуется
 *      уже по ней — пользователь видит граф сразу, а не белый экран.
 *   2. УТОЧНЕНИЕ — силовая релаксация (отталкивание Барнса–Хата + пружины по
 *      рёбрам + слабое стягивание к центру), позиции стримятся наружу пачками
 *      каждые несколько итераций. Пан и зум всё это время работают.
 *
 * Внешних зависимостей нет ни одной: d3-force сюда не едет — он тянет
 * бандлер и вес, а нужен из него один алгоритм, который здесь и написан.
 */

interface StartMessage {
  readonly type: "layout";
  readonly n: number;
  /** Индекс вида на узел — им же задаётся кластер засева. */
  readonly kinds: Uint8Array;
  readonly kindCount: number;
  readonly deg: Uint16Array;
  /** Пары индексов узлов, длина = 2·|E|. */
  readonly edges: Int32Array;
  readonly iterations?: number;
  /** Потолок времени уточнения, мс; по истечении — останов на текущей итерации. */
  readonly budgetMs?: number;
  readonly seed?: number;
}

type InMessage = StartMessage | { readonly type: "stop" };

const THETA = 0.9;
const THETA2 = THETA * THETA;
const DEFAULT_ITERATIONS = 260;
const DEFAULT_BUDGET_MS = 9000;
/** Каждые столько итераций позиции уходят наружу — 8 даёт заметное движение
 *  и не забивает канал сообщениями. */
const EMIT_EVERY = 8;

let generation = 0;

/** Детерминированный PRNG: одинаковая база даёт одинаковую картинку. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Засев: кластеры видов по окружности, внутри — спираль Фибоначчи по
 * убыванию степени, поэтому в центре кластера оказываются хабы. Один проход,
 * никаких итераций.
 */
function seedPositions(
  n: number,
  kinds: Uint8Array,
  kindCount: number,
  deg: Uint16Array,
  seed: number,
): Float32Array {
  const pos = new Float32Array(n * 2);
  if (n === 0) return pos;
  const rnd = mulberry32(seed);

  const members: number[][] = [];
  for (let k = 0; k < kindCount; k++) members.push([]);
  for (let i = 0; i < n; i++) {
    const k = kinds[i] ?? 0;
    (members[k] ?? members[0]!).push(i);
  }
  const used = members.filter((m) => m.length > 0);
  const R = Math.sqrt(n) * 26 + 120;
  const golden = Math.PI * (3 - Math.sqrt(5));

  let c = 0;
  for (const group of used) {
    group.sort((a, b) => (deg[b] ?? 0) - (deg[a] ?? 0) || a - b);
    const angle = used.length === 1 ? 0 : (2 * Math.PI * c) / used.length;
    const cx = used.length === 1 ? 0 : Math.cos(angle) * R;
    const cy = used.length === 1 ? 0 : Math.sin(angle) * R;
    const spread = Math.sqrt(group.length) * 11 + 22;
    for (let j = 0; j < group.length; j++) {
      const idx = group[j]!;
      const r = spread * Math.sqrt((j + 0.5) / group.length);
      const a = j * golden;
      pos[idx * 2] = cx + Math.cos(a) * r + (rnd() - 0.5) * 2;
      pos[idx * 2 + 1] = cy + Math.sin(a) * r + (rnd() - 0.5) * 2;
    }
    c++;
  }
  return pos;
}

/**
 * Квадродерево Барнса–Хата на типизированных массивах. Классическая форма:
 * узел либо пустой, либо лист с одним телом, либо внутренний с четырьмя
 * детьми. Массивы переиспользуются между итерациями — аллокаций в цикле нет.
 */
class Quadtree {
  private cap: number;
  x0: Float32Array;
  y0: Float32Array;
  half: Float32Array;
  mass: Float32Array;
  cx: Float32Array;
  cy: Float32Array;
  child: Int32Array;
  body: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.cap = Math.max(64, capacity);
    this.x0 = new Float32Array(this.cap);
    this.y0 = new Float32Array(this.cap);
    this.half = new Float32Array(this.cap);
    this.mass = new Float32Array(this.cap);
    this.cx = new Float32Array(this.cap);
    this.cy = new Float32Array(this.cap);
    this.child = new Int32Array(this.cap * 4);
    this.body = new Int32Array(this.cap);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const gf = (a: Float32Array): Float32Array => {
      const b = new Float32Array(cap);
      b.set(a);
      return b;
    };
    this.x0 = gf(this.x0);
    this.y0 = gf(this.y0);
    this.half = gf(this.half);
    this.mass = gf(this.mass);
    this.cx = gf(this.cx);
    this.cy = gf(this.cy);
    const nc = new Int32Array(cap * 4).fill(-1);
    nc.set(this.child);
    this.child = nc;
    const nb = new Int32Array(cap).fill(-1);
    nb.set(this.body);
    this.body = nb;
    this.cap = cap;
  }

  private alloc(x0: number, y0: number, half: number): number {
    if (this.count >= this.cap) this.grow();
    const i = this.count++;
    this.x0[i] = x0;
    this.y0[i] = y0;
    this.half[i] = half;
    this.mass[i] = 0;
    this.cx[i] = 0;
    this.cy[i] = 0;
    this.body[i] = -1;
    this.child[i * 4] = -1;
    this.child[i * 4 + 1] = -1;
    this.child[i * 4 + 2] = -1;
    this.child[i * 4 + 3] = -1;
    return i;
  }

  build(pos: Float32Array, n: number): void {
    this.count = 0;
    if (n === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2]!;
      const y = pos[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const half = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
    this.alloc((minX + maxX) / 2 - half, (minY + maxY) / 2 - half, half);
    for (let i = 0; i < n; i++) this.insert(i, pos);
  }

  private insert(bodyIdx: number, pos: Float32Array): void {
    const bx = pos[bodyIdx * 2]!;
    const by = pos[bodyIdx * 2 + 1]!;
    let node = 0;
    for (let depth = 0; depth < 48; depth++) {
      // Центр масс обновляется на спуске: второго прохода по дереву не нужно.
      const m = this.mass[node]!;
      this.cx[node] = (this.cx[node]! * m + bx) / (m + 1);
      this.cy[node] = (this.cy[node]! * m + by) / (m + 1);
      this.mass[node] = m + 1;

      const existing = this.body[node]!;
      const isLeaf = this.child[node * 4] === -1;
      if (isLeaf && existing === -1 && m === 0) {
        this.body[node] = bodyIdx;
        return;
      }
      if (isLeaf && existing !== -1) {
        // Лист занят — раскрываем его в четыре четверти и роняем туда старое
        // тело; ниже в этой же итерации спустится и новое.
        this.body[node] = -1;
        this.split(node);
        const eq = this.quadrant(node, pos[existing * 2]!, pos[existing * 2 + 1]!);
        const ec = this.child[node * 4 + eq]!;
        this.body[ec] = existing;
        this.mass[ec] = 1;
        this.cx[ec] = pos[existing * 2]!;
        this.cy[ec] = pos[existing * 2 + 1]!;
      } else if (isLeaf) {
        this.split(node);
      }
      const q = this.quadrant(node, bx, by);
      node = this.child[node * 4 + q]!;
    }
    // Совпавшие координаты: глубже спускаться некуда — тело просто учтено
    // в массе выше, силу от него дадут соседи по листу.
  }

  private split(node: number): void {
    const h = this.half[node]! / 2;
    const x = this.x0[node]!;
    const y = this.y0[node]!;
    this.child[node * 4] = this.alloc(x, y, h);
    this.child[node * 4 + 1] = this.alloc(x + h, y, h);
    this.child[node * 4 + 2] = this.alloc(x, y + h, h);
    this.child[node * 4 + 3] = this.alloc(x + h, y + h, h);
  }

  private quadrant(node: number, x: number, y: number): number {
    const h = this.half[node]!;
    const right = x >= this.x0[node]! + h ? 1 : 0;
    const bottom = y >= this.y0[node]! + h ? 2 : 0;
    return right + bottom;
  }
}

function repulse(
  tree: Quadtree,
  pos: Float32Array,
  vel: Float32Array,
  i: number,
  strength: number,
  stack: Int32Array,
): void {
  const px = pos[i * 2]!;
  const py = pos[i * 2 + 1]!;
  let sp = 0;
  stack[sp++] = 0;
  let fx = 0;
  let fy = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    const m = tree.mass[node]!;
    if (m === 0) continue;
    let dx = tree.cx[node]! - px;
    let dy = tree.cy[node]! - py;
    let d2 = dx * dx + dy * dy;
    const w = tree.half[node]! * 2;
    const isLeaf = tree.child[node * 4] === -1;
    if (isLeaf || w * w < THETA2 * d2) {
      if (isLeaf && tree.body[node] === i) continue;
      if (d2 < 1e-4) {
        // Совпали точка в точку — толкаем детерминированно, а не в NaN.
        dx = ((i % 7) - 3) * 0.01;
        dy = ((i % 5) - 2) * 0.01;
        d2 = dx * dx + dy * dy + 1e-6;
      }
      const f = (-strength * m) / d2;
      fx += dx * f;
      fy += dy * f;
    } else {
      for (let c = 0; c < 4; c++) {
        const ch = tree.child[node * 4 + c]!;
        if (ch !== -1 && tree.mass[ch]! > 0) stack[sp++] = ch;
      }
    }
  }
  vel[i * 2] = vel[i * 2]! + fx;
  vel[i * 2 + 1] = vel[i * 2 + 1]! + fy;
}

let stopRequested = false;

function run(msg: StartMessage): void {
  const gen = ++generation;
  stopRequested = false;
  const t0 = performance.now();
  const n = msg.n;
  const pos = seedPositions(n, msg.kinds, msg.kindCount, msg.deg, msg.seed ?? 0x9e3779b9);
  const seedMs = performance.now() - t0;

  // Первый кадр обязан уйти немедленно. Наружу отдаётся копия: локальная
  // `pos` продолжает жить в воркере и уточняться дальше.
  self.postMessage({ type: "seed", generation: gen, positions: pos.slice(), n, ms: Math.round(seedMs) });
  if (n < 2) {
    self.postMessage({ type: "done", generation: gen, positions: pos.slice(), iter: 0, ms: Math.round(seedMs) });
    return;
  }

  const edges = msg.edges;
  const edgeCount = edges.length >>> 1;
  const iterations = msg.iterations ?? DEFAULT_ITERATIONS;
  const budget = msg.budgetMs ?? DEFAULT_BUDGET_MS;

  const vel = new Float32Array(n * 2);
  const tree = new Quadtree(Math.min(4 * n + 64, 1_500_000));
  const stack = new Int32Array(4096);

  // Масштаб сил от размера графа: на 10k узлов те же константы, что на 100,
  // дают либо взрыв, либо слипшийся ком.
  const repulsion = 900 + n * 0.35;
  const springLen = 26 + Math.min(40, edgeCount / Math.max(1, n)) * 2;
  const springK = 0.06;
  const centerK = 0.008;
  let alpha = 1;
  const decay = Math.pow(0.02, 1 / iterations);

  let iter = 0;
  const step = (): void => {
    if (gen !== generation || stopRequested) return;
    const sliceStart = performance.now();
    // Считаем пачкой до EMIT_EVERY итераций, затем отдаём кадр наружу.
    for (let k = 0; k < EMIT_EVERY && iter < iterations; k++, iter++) {
      tree.build(pos, n);
      for (let i = 0; i < n; i++) {
        vel[i * 2] = vel[i * 2]! * 0.6;
        vel[i * 2 + 1] = vel[i * 2 + 1]! * 0.6;
        repulse(tree, pos, vel, i, repulsion, stack);
        vel[i * 2] = vel[i * 2]! - pos[i * 2]! * centerK;
        vel[i * 2 + 1] = vel[i * 2 + 1]! - pos[i * 2 + 1]! * centerK;
      }
      for (let e = 0; e < edgeCount; e++) {
        const a = edges[e * 2]!;
        const b = edges[e * 2 + 1]!;
        const dx = pos[b * 2]! - pos[a * 2]!;
        const dy = pos[b * 2 + 1]! - pos[a * 2 + 1]!;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
        const f = ((d - springLen) * springK) / d;
        const fx = dx * f;
        const fy = dy * f;
        vel[a * 2] = vel[a * 2]! + fx;
        vel[a * 2 + 1] = vel[a * 2 + 1]! + fy;
        vel[b * 2] = vel[b * 2]! - fx;
        vel[b * 2 + 1] = vel[b * 2 + 1]! - fy;
      }
      for (let i = 0; i < n * 2; i++) {
        const v = Math.max(-40, Math.min(40, vel[i]! * alpha));
        pos[i] = pos[i]! + v;
      }
      alpha *= decay;
      if (performance.now() - sliceStart > 220) {
        // Кадр затянулся — отдаём что есть. `break` пропускает инкремент
        // заголовка цикла, поэтому итерацию засчитываем руками.
        iter++;
        break;
      }
    }

    const elapsed = performance.now() - t0;
    const finished = iter >= iterations || elapsed > budget;
    self.postMessage({
      type: finished ? "done" : "tick",
      generation: gen,
      positions: pos.slice(),
      iter,
      total: iterations,
      ms: Math.round(elapsed),
    });
    if (!finished) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

self.onmessage = (event: MessageEvent<InMessage>): void => {
  const msg = event.data;
  if (msg.type === "stop") {
    stopRequested = true;
    generation++;
    return;
  }
  if (msg.type === "layout") run(msg);
};
