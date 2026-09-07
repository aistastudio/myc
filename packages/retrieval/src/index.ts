// TODO(myc-7yk): implement hybrid retrieval (FTS5 BM25 + vectors + graph
// expansion, merged with RRF) in a single SQL round-trip.
export type RetrievalQuery = {
  readonly text: string;
  readonly limit?: number;
};

// Публичный API пакета — подключается координатором при приёмке.
export * from "./fts.ts";
export * from "./vector.ts";
export * from "./hybrid.ts";
export * from "./boost-config.ts";
export * from "./federation.ts";
export * from "./budget.ts";
export * from "./cache.ts";
