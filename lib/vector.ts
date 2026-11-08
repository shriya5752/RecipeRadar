import { createHash } from "node:crypto";
import { all, one, run, transaction, RECIPE_COLUMNS } from "./db.ts";

export const COLLECTION = "reciperadar_recipes";
export const VECTOR_SIZE = 128;
// Default: embeddings live in PostgreSQL (vector_documents) and are searched by fn_search_vectors().
// Set QDRANT_URL to use an external Qdrant service instead.
const backend = process.env.QDRANT_URL ? "qdrant" : "postgres-vector";
const url = (process.env.QDRANT_URL || "").replace(/\/$/, "");
const synonyms: Record<string, string> = {
  creamy: "smooth",
  silky: "smooth",
  rich: "smooth",
  tangy: "bright",
  citrus: "bright",
  lemon: "bright",
  fresh: "bright",
  herb: "bright",
  nutty: "roasted",
  peanut: "roasted",
  almond: "roasted",
  toasty: "roasted",
  earthy: "savory",
  umami: "savory",
  smoky: "savory",
  sweet: "sweet",
  banana: "sweet",
  spicy: "heat",
  chili: "heat",
  curry: "warm",
  ginger: "warm",
  crunchy: "crisp",
  crisp: "crisp",
  vegan: "plant",
  vegetarian: "plant",
  lentil: "legume",
  chickpea: "legume",
  beans: "legume",
  chicken: "protein",
  salmon: "protein",
  tofu: "protein",
};
const stop = new Set([
  "and",
  "the",
  "with",
  "from",
  "into",
  "your",
  "this",
  "that",
  "for",
  "are",
  "its",
  "you",
  "all",
  "serve",
  "until",
  "then",
  "have",
  "make",
  "recipe",
]);
export function embed(text: string): number[] {
  const vector = Array<number>(VECTOR_SIZE).fill(0);
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t))
    .flatMap((t) => [t, synonyms[t]].filter(Boolean));
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash.readUInt32BE(0) % VECTOR_SIZE;
    const sign = hash[4] & 1 ? -1 : 1;
    vector[index] += sign * (1 + Math.min(token.length, 12) / 12);
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}
export async function recipeDocument(id: number) {
  const r = await one(
    `SELECT ${RECIPE_COLUMNS},c.name cuisine,d.name diet FROM recipes r JOIN cuisines c USING(cuisine_id) JOIN dietary_types d USING(diet_id) WHERE recipe_id=?`,
    id,
  );
  if (!r) return null;
  const ingredients = await all(
    "SELECT i.name,ri.quantity,ri.unit,i.flavor FROM recipe_ingredients ri JOIN ingredients i USING(ingredient_id) WHERE recipe_id=? ORDER BY i.name",
    id,
  );
  const text = [
    r.title,
    r.description,
    r.flavor,
    r.meal_type,
    r.cuisine,
    r.diet,
    ...ingredients.map((i) => i.name),
    ...ingredients.map((i) => i.flavor),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    vector: embed(text),
    payload: {
      recipe_id: id,
      title: r.title,
      description: r.description || "",
      cuisine: r.cuisine,
      diet: r.diet,
      meal_type: r.meal_type,
      calories_per_serving: r.calories_per_serving,
      ingredients: ingredients.map((i) => i.name),
      text,
    },
  };
}
async function qdrant(path: string, init?: RequestInit) {
  const response = await fetch(url + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `Qdrant ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response.status === 204 ? null : response.json();
}
export async function ensureCollection() {
  if (backend === "postgres-vector") return true;
  try {
    await qdrant(`/collections/${COLLECTION}`);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("404"))
      throw error;
  }
  try {
    await qdrant(`/collections/${COLLECTION}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: VECTOR_SIZE, distance: "Cosine" },
      }),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("409"))
      throw error;
  }
  return true;
}
const UPSERT_VECTOR =
  "INSERT INTO vector_documents(recipe_id,embedding,payload) VALUES(?,?::float8[],?::jsonb) ON CONFLICT(recipe_id) DO UPDATE SET embedding=excluded.embedding,payload=excluded.payload,updated_at=now()";
export async function syncOutbox(limit = 100) {
  const rows = await all(
    "SELECT * FROM vector_sync_outbox ORDER BY outbox_id LIMIT ?",
    limit,
  );
  if (backend === "postgres-vector") {
    if (rows.length)
      await transaction(async () => {
        for (const row of rows) {
          if (row.operation === "delete")
            await run(
              "DELETE FROM vector_documents WHERE recipe_id=?",
              row.recipe_id,
            );
          else if (row.payload)
            await run(
              UPSERT_VECTOR,
              row.recipe_id,
              row.payload.vector,
              JSON.stringify(row.payload.payload),
            );
          await run(
            "DELETE FROM vector_sync_outbox WHERE outbox_id=?",
            row.outbox_id,
          );
        }
      });
    return rows.length;
  }
  await ensureCollection();
  let synced = 0;
  for (const row of rows) {
    try {
      if (row.operation === "delete")
        await qdrant(
          `/collections/${COLLECTION}/points/${row.recipe_id}?wait=true`,
          { method: "DELETE" },
        );
      else if (row.payload)
        await qdrant(`/collections/${COLLECTION}/points?wait=true`, {
          method: "PUT",
          body: JSON.stringify({ points: [row.payload] }),
        });
      await run("DELETE FROM vector_sync_outbox WHERE outbox_id=?", row.outbox_id);
      synced++;
    } catch (error) {
      await run(
        "UPDATE vector_sync_outbox SET attempts=attempts+1,last_error=? WHERE outbox_id=?",
        String(error).slice(0, 500),
        row.outbox_id,
      );
      throw error;
    }
  }
  return synced;
}
export async function bootstrapIndex() {
  const points: NonNullable<Awaited<ReturnType<typeof recipeDocument>>>[] = [];
  // Sequential on purpose: a request transaction uses a single database connection.
  for (const r of await all("SELECT recipe_id FROM recipes WHERE is_approved")) {
    const point = await recipeDocument(r.recipe_id);
    if (point) points.push(point);
  }
  if (backend === "postgres-vector") {
    await transaction(async () => {
      for (const point of points)
        await run(
          UPSERT_VECTOR,
          point.id,
          point.vector,
          JSON.stringify(point.payload),
        );
      await run(
        "DELETE FROM vector_documents WHERE recipe_id NOT IN (SELECT recipe_id FROM recipes WHERE is_approved)",
      );
    });
    await syncOutbox();
    return points.length;
  }
  await ensureCollection();
  for (let i = 0; i < points.length; i += 64) {
    const chunk = points.slice(i, i + 64);
    if (chunk.length)
      await qdrant(`/collections/${COLLECTION}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ points: chunk }),
      });
  }
  await syncOutbox();
  return points.length;
}
export async function searchVector(query: string, limit = 8) {
  await ensureCollection();
  await syncOutbox();
  const vector = embed(query);
  if (backend === "postgres-vector")
    // Cosine similarity ranking runs inside PostgreSQL (fn_search_vectors).
    return {
      result: (
        await all("SELECT recipe_id id,score,payload FROM fn_search_vectors(?::float8[],?)", vector, limit)
      ).map((row) => ({ id: row.id, score: row.score, payload: row.payload })),
    };
  return qdrant(`/collections/${COLLECTION}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      with_vector: false,
    }),
  });
}
export async function getVector(id: number) {
  await ensureCollection();
  if (backend === "postgres-vector") {
    const row = await one(
      "SELECT recipe_id,embedding,payload,updated_at FROM vector_documents WHERE recipe_id=?",
      id,
    );
    if (!row) throw Error("Vector document not found");
    return {
      result: {
        id: row.recipe_id,
        vector: row.embedding,
        payload: row.payload,
        updated_at: row.updated_at,
      },
    };
  }
  return qdrant(
    `/collections/${COLLECTION}/points/${id}?with_payload=true&with_vector=true`,
  );
}
export async function deleteVector(id: number) {
  await ensureCollection();
  if (backend === "postgres-vector")
    return run("DELETE FROM vector_documents WHERE recipe_id=?", id);
  return qdrant(`/collections/${COLLECTION}/points/${id}?wait=true`, {
    method: "DELETE",
  });
}
export async function collectionInfo() {
  await ensureCollection();
  if (backend === "postgres-vector")
    return {
      backend,
      result: {
        status: "green",
        points_count: Number((await one("SELECT COUNT(*) n FROM vector_documents")).n),
      },
    };
  return qdrant(`/collections/${COLLECTION}`).then((r: any) => ({
    backend,
    result: r.result,
  }));
}
