// TODO(myc-c8z): implement the anchors table and file:line lookup
// (repo + path + span + blob_hash + crux_text; graft adapter stays out of
// the hot path).
export type Anchor = {
  readonly repo: string;
  readonly path: string;
};
