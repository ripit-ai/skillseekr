const K1 = 1.2;
const B = 0.75;

/** Lowercase, split on non-alphanumerics, keep tokens of at least 2 characters. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

export interface SearchDoc { id: string; name: string; description: string }

/** Field weighting by repetition: name x3, id path segments x2, description x1. */
export function docTokens(d: SearchDoc): string[] {
  const n = tokenize(d.name);
  const i = tokenize(d.id);
  return [...n, ...n, ...n, ...i, ...i, ...tokenize(d.description)];
}

export class Bm25Index {
  private readonly tfs: Array<Map<string, number>>;
  private readonly lens: number[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(docs: SearchDoc[]) {
    this.tfs = [];
    this.lens = [];
    for (const d of docs) {
      const toks = docTokens(d);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      this.lens.push(toks.length);
    }
    this.avgdl = docs.length ? this.lens.reduce((a, b) => a + b, 0) / docs.length : 0;
  }

  /** Score for every document index (0 where nothing matches). */
  scores(query: string): number[] {
    const q = [...new Set(tokenize(query))];
    const N = this.tfs.length;
    return this.tfs.map((tf, i) => {
      let s = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * this.lens[i]!) / (this.avgdl || 1)));
      }
      return s;
    });
  }
}
