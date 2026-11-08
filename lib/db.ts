import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { Pool, PoolClient } from "pg";
export { hash, verify } from "./password.ts";

// Result-type parsing so the API returns the same JSON shapes as before:
// DATE -> "YYYY-MM-DD", TIMESTAMPTZ -> ISO string, NUMERIC -> number, BIGINT -> number.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));
pg.types.setTypeParser(20, (v: string) => Number(v));

let pool: Pool | undefined;
/** Lazily create the pool so `next build` does not need database credentials. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env.local and configure it.",
      );
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export type DbRole = "rr_guest" | "rr_user" | "rr_admin";
const scope = new AsyncLocalStorage<PoolClient>();

// SQL in this codebase uses `?` placeholders; PostgreSQL wants $1, $2, ...
const numbered = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
const exec = (sql: string, args: any[]) =>
  (scope.getStore() ?? getPool()).query(numbered(sql), args);

export const all = async (sql: string, ...args: any[]) =>
  (await exec(sql, args)).rows as any[];
export const one = async (sql: string, ...args: any[]) =>
  (await exec(sql, args)).rows[0] as any;
export const run = (sql: string, ...args: any[]) => exec(sql, args);

/**
 * Run `fn` in one database transaction as a least-privilege role. The app logs in as
 * rr_app and switches to rr_guest / rr_user / rr_admin with SET LOCAL ROLE, so grants and
 * row-level security are enforced by PostgreSQL itself. rr.user_id identifies the caller to
 * the policies, the audit trigger and sp_generate_meal_plan.
 */
export async function asRole<T>(
  role: DbRole | null,
  userId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (role) {
      // Role names come from a fixed union, never from user input.
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('rr.user_id', $1, true)", [
        userId == null ? "" : String(userId),
      ]);
    }
    const value = await scope.run(client, fn);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Nested transaction: a SAVEPOINT inside a request, or a fresh transaction outside one. */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = scope.getStore();
  if (client) {
    await client.query("SAVEPOINT rr_tx");
    try {
      const value = await fn();
      await client.query("RELEASE SAVEPOINT rr_tx");
      return value;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT rr_tx");
      throw error;
    }
  }
  return asRole(null, null, fn);
}

const RECIPE_COLUMNS =
  "r.recipe_id,r.title,r.description,r.instructions,r.prep_time_minutes,r.cook_time_minutes,r.servings," +
  "r.calories_per_serving,r.protein_g,r.carbs_g,r.fat_g,r.avg_rating,r.total_views,r.cuisine_id,r.diet_id," +
  "r.created_by,r.is_approved,r.created_at,r.image,r.meal_type,r.flavor";
export { RECIPE_COLUMNS };

/** Recipes with ingredients, allergens, the user's favorite flag and allergy conflicts. */
export async function recipes(userId?: number, includeMine = false) {
  const allergies: number[] = userId
    ? (
        await all(
          "SELECT allergen_id FROM user_allergens WHERE user_id=?",
          userId,
        )
      ).map((a) => a.allergen_id)
    : [];
  const favorites = new Set<number>(
    userId
      ? (await all("SELECT recipe_id FROM favorites WHERE user_id=?", userId)).map(
          (f) => f.recipe_id,
        )
      : [],
  );
  const rows = await all(
    `SELECT ${RECIPE_COLUMNS}, c.name cuisine, d.name diet,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) || jsonb_build_object('quantity', ri.quantity, 'unit', ri.unit)
                                  ORDER BY i.ingredient_id), '[]'::jsonb)
          FROM recipe_ingredients ri JOIN ingredients i USING (ingredient_id)
         WHERE ri.recipe_id = r.recipe_id) AS ingredients,
       (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.allergen_id), '[]'::jsonb)
          FROM (SELECT DISTINCT al.* FROM recipe_ingredients ri
                  JOIN ingredient_allergens ia USING (ingredient_id)
                  JOIN allergens al USING (allergen_id)
                 WHERE ri.recipe_id = r.recipe_id) a) AS allergens
     FROM recipes r JOIN cuisines c USING (cuisine_id) JOIN dietary_types d USING (diet_id)
     WHERE r.is_approved OR (?::int = 1 AND r.created_by = ?)
     ORDER BY r.recipe_id`,
    includeMine ? 1 : 0,
    userId ?? 0,
  );
  return rows.map((r) => ({
    ...r,
    favorite: favorites.has(r.recipe_id),
    conflicts: r.allergens.filter((a: any) => allergies.includes(a.allergen_id)),
  }));
}
