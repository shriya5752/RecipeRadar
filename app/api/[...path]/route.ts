import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import {
  all,
  one,
  run,
  transaction,
  asRole,
  hash,
  verify,
  recipes,
  RECIPE_COLUMNS,
  type DbRole,
} from "../../../lib/db";
import {
  bootstrapIndex,
  collectionInfo,
  getVector,
  recipeDocument,
  searchVector,
  syncOutbox,
} from "../../../lib/vector";
export const runtime = "nodejs";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
// Pre-authentication lookup: runs as the rr_app login role (sessions + users only).
async function user(req: NextRequest) {
  const token = req.cookies.get("rr_session")?.value;
  return token
    ? await one(
        "SELECT u.* FROM sessions s JOIN users u USING(user_id) WHERE s.token=? AND s.expires_at>?",
        digest(token),
        Date.now(),
      )
    : null;
}
const roleOf = (u: any): DbRole =>
  !u ? "rr_guest" : u.role === "admin" ? "rr_admin" : "rr_user";
async function safe(u: any) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return {
    ...rest,
    allergens: (
      await all("SELECT allergen_id FROM user_allergens WHERE user_id=?", u.user_id)
    ).map((x) => x.allergen_id),
  };
}
async function enqueueVector(recipeId: number, operation: "upsert" | "delete") {
  const point = operation === "upsert" ? await recipeDocument(recipeId) : null;
  check(operation === "delete" || point, "Could not create recipe vector");
  await run(
    `INSERT INTO vector_sync_outbox(recipe_id,operation,payload) VALUES(?,?,?::jsonb)
     ON CONFLICT(recipe_id,operation) DO UPDATE SET payload=excluded.payload,attempts=0,last_error=NULL,created_at=now()`,
    recipeId,
    operation,
    point ? JSON.stringify(point) : null,
  );
}
function requireAdmin(u: any) {
  check(u?.role === "admin", "Administrator permission required");
}
function check(ok: any, message: string) {
  if (!ok) throw new Error(message);
}
const has = async (sql: string, ...args: any[]) => !!(await one(sql, ...args));
// A request runs on ONE database connection, so queries must not overlap: map sequentially.
async function seq<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}
function integer(v: any, min: number, max: number) {
  return Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
}
async function authenticate(req: NextRequest, b: any) {
  if (b.mode === "logout") {
    const token = req.cookies.get("rr_session")?.value;
    if (token) await run("DELETE FROM sessions WHERE token=?", digest(token));
    const r = NextResponse.json({ ok: true });
    r.cookies.delete("rr_session");
    return r;
  }
  check(
    typeof b.email === "string" && typeof b.password === "string",
    "Email and password are required",
  );
  const email = b.email.trim().toLowerCase();
  check(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255,
    "Enter a valid email",
  );
  check(
    b.password.length >= 8 && b.password.length <= 128,
    "Use a password of 8–128 characters",
  );
  if (b.mode === "register") {
    check(
      typeof b.name === "string" &&
        b.name.trim().length > 0 &&
        b.name.length <= 100,
      "Enter your name",
    );
    check(
      !(await has("SELECT 1 FROM users WHERE lower(email)=?", email)),
      "This email is already registered",
    );
    await run(
      "INSERT INTO users(name,email,password_hash) VALUES(?,?,?)",
      b.name.trim(),
      email,
      hash(b.password),
    );
  }
  const account = await one("SELECT * FROM users WHERE lower(email)=?", email);
  check(
    account && verify(b.password, account.password_hash),
    "Incorrect email or password",
  );
  const token = randomBytes(32).toString("hex");
  await run("DELETE FROM sessions WHERE expires_at<?", Date.now());
  await run(
    "INSERT INTO sessions VALUES(?,?,?)",
    digest(token),
    account.user_id,
    Date.now() + 7 * 86400000,
  );
  return { account, token };
}

async function dispatch(req: NextRequest, path: string, u: any, b: any) {
  const id = u?.user_id;
  if (req.method === "GET") {
    if (path === "bootstrap")
      return NextResponse.json({
        user: await safe(u),
        recipes: await recipes(id, !!id),
        allergens: await all("SELECT * FROM allergens ORDER BY allergen_id"),
        ingredients: await all("SELECT * FROM ingredients ORDER BY ingredient_id"),
        cuisines: await all("SELECT * FROM cuisines ORDER BY cuisine_id"),
        diets: await all("SELECT * FROM dietary_types ORDER BY diet_id"),
      });
    if (path === "plans") {
      check(u, "Sign in to view your plans");
      const plans = await all(
        "SELECT * FROM meal_plans WHERE user_id=? ORDER BY plan_id DESC",
        id,
      );
      return NextResponse.json(
        await seq(plans, async (p) => ({
          ...p,
          meals: await all(
            "SELECT m.*,r.title,r.calories_per_serving,r.image FROM meal_plan_recipes m JOIN recipes r USING(recipe_id) WHERE plan_id=? ORDER BY meal_date,CASE m.meal_type WHEN 'Breakfast' THEN 1 WHEN 'Lunch' THEN 2 ELSE 3 END",
            p.plan_id,
          ),
        })),
      );
    }
    if (path === "admin/recipes") {
      requireAdmin(u);
      return NextResponse.json({
        pending: await all(
          `SELECT ${RECIPE_COLUMNS},u.name creator,c.name cuisine,d.name diet FROM recipes r JOIN users u ON u.user_id=r.created_by JOIN cuisines c USING(cuisine_id) JOIN dietary_types d USING(diet_id) WHERE NOT is_approved ORDER BY created_at`,
        ),
        users: await all(
          "SELECT user_id,name,email,role,created_at FROM users ORDER BY user_id",
        ),
        audit: await all(
          "SELECT audit_id,table_name,record_id,action,old_value,new_value,actor_user_id,changed_at FROM audit_log ORDER BY audit_id DESC LIMIT 20",
        ),
      });
    }
    if (path === "vector") {
      check(u, "Sign in to use flavor search");
      await syncOutbox();
      const indexed = await bootstrapIndex();
      await syncOutbox();
      const info = await collectionInfo();
      return NextResponse.json({
        backend: info.backend,
        collection: info.result?.status,
        vectors: info.result?.points_count ?? 0,
        pending: Number((await one("SELECT COUNT(*) n FROM vector_sync_outbox")).n),
        indexed,
      });
    }
    if (path === "search") {
      // PostgreSQL full-text search (tsvector + GIN index) with ranking.
      const q = req.nextUrl.searchParams.get("q") ?? "";
      check(q.trim().length >= 2 && q.length <= 200, "Enter a search of 2–200 characters");
      return NextResponse.json(
        await all("SELECT recipe_id,title,rank FROM fn_search_recipes(?,20)", q.trim()),
      );
    }
    if (path === "substitutions") {
      const subs = await all(
        "SELECT s.*,a.name original,b.name replacement FROM substitutions s JOIN ingredients a ON a.ingredient_id=s.ingredient_id_from JOIN ingredients b ON b.ingredient_id=s.ingredient_id_to",
      );
      return NextResponse.json(
        await seq(subs, async (s) => ({
          ...s,
          conflicts: id
            ? await all(
                "SELECT a.name FROM ingredient_allergens ia JOIN user_allergens ua USING(allergen_id) JOIN allergens a USING(allergen_id) WHERE ia.ingredient_id=? AND ua.user_id=?",
                s.ingredient_id_to,
                id,
              )
            : [],
        })),
      );
    }
    if (path.startsWith("reviews/")) {
      const rid = Number(path.split("/")[1]);
      check(Number.isSafeInteger(rid), "Invalid recipe");
      return NextResponse.json(
        await all(
          "SELECT r.rating_value,r.review_text,r.created_at,u.name FROM ratings r JOIN users u USING(user_id) WHERE recipe_id=? ORDER BY r.created_at DESC",
          rid,
        ),
      );
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  check(u, "Sign in to continue");
  if (path === "admin/review") {
    requireAdmin(u);
    check(integer(b.recipe_id, 1, Number.MAX_SAFE_INTEGER), "Invalid recipe");
    check(typeof b.approved === "boolean", "Approval must be true or false");
    check(
      await has("SELECT 1 FROM recipes WHERE recipe_id=?", b.recipe_id),
      "Recipe not found",
    );
    await transaction(async () => {
      await run("UPDATE recipes SET is_approved=? WHERE recipe_id=?", b.approved, b.recipe_id);
      await enqueueVector(b.recipe_id, b.approved ? "upsert" : "delete");
    });
    await syncOutbox();
    return NextResponse.json({ ok: true });
  }
  if (path === "admin/role") {
    requireAdmin(u);
    check(integer(b.user_id, 1, Number.MAX_SAFE_INTEGER), "Invalid user");
    check(["user", "admin"].includes(b.role), "Role must be user or admin");
    check(await has("SELECT 1 FROM users WHERE user_id=?", b.user_id), "User not found");
    // The "last administrator" rule is enforced by the users_protect_last_admin trigger.
    await run("UPDATE users SET role=? WHERE user_id=?", b.role, b.user_id);
    return NextResponse.json({ ok: true });
  }
  if (path === "vector") {
    const action = b.action;
    if (action === "search") {
      check(
        typeof b.query === "string" &&
          b.query.trim().length >= 2 &&
          b.query.length <= 300,
        "Enter a search of 2–300 characters",
      );
      await bootstrapIndex();
      const response: any = await searchVector(
        b.query.trim(),
        Math.min(Math.max(Number(b.limit) || 8, 1), 20),
      );
      const visibleRecipes = await recipes(id, true);
      const visible = (response.result || [])
        .map((hit: any) => ({
          recipe: visibleRecipes.find((r) => r.recipe_id === Number(hit.id)),
          score: hit.score,
        }))
        .filter(
          (item: any) =>
            item.recipe &&
            (item.recipe.is_approved || item.recipe.created_by === id),
        );
      return NextResponse.json({ results: visible });
    }
    check(integer(b.recipe_id, 1, Number.MAX_SAFE_INTEGER), "Invalid recipe");
    const recipe = await one(
      "SELECT recipe_id,created_by,is_approved FROM recipes WHERE recipe_id=?",
      b.recipe_id,
    );
    check(recipe, "Recipe not found");
    check(
      u.role === "admin" || recipe.created_by === id,
      "You can only manage vectors for your recipes",
    );
    if (action === "read")
      return NextResponse.json(await getVector(Number(b.recipe_id)));
    if (action === "upsert") {
      check(recipe.is_approved, "Only approved recipes are indexed");
      await bootstrapIndex();
      await syncOutbox();
      return NextResponse.json({
        ok: true,
        vector: await getVector(Number(b.recipe_id)),
      });
    }
    if (action === "delete") {
      await transaction(async () => {
        await enqueueVector(Number(b.recipe_id), "delete");
        await run("DELETE FROM recipes WHERE recipe_id=?", b.recipe_id);
      });
      await syncOutbox();
      return NextResponse.json({ ok: true });
    }
    throw new Error("Action must be search, read, upsert, or delete");
  }
  if (path === "profile") {
    check(
      typeof b.name === "string" &&
        b.name.trim().length > 0 &&
        b.name.length <= 100,
      "Enter a valid name",
    );
    check(
      integer(b.daily_calorie_target, 800, 6000),
      "Calorie target must be 800–6000",
    );
    check(
      ["Balanced", "Vegan", "Vegetarian", "High protein"].includes(b.diet_goal),
      "Choose a valid diet",
    );
    check(
      Array.isArray(b.allergens) &&
        (
          await seq(
            b.allergens,
            async (a: any) =>
              Number.isInteger(Number(a)) &&
              (await has("SELECT 1 FROM allergens WHERE allergen_id=?", Number(a))),
          )
        ).every(Boolean),
      "Invalid allergens",
    );
    await transaction(async () => {
      await run(
        "UPDATE users SET name=?,diet_goal=?,daily_calorie_target=? WHERE user_id=?",
        b.name.trim(),
        b.diet_goal,
        Number(b.daily_calorie_target),
        id,
      );
      await run("DELETE FROM user_allergens WHERE user_id=?", id);
      for (const a of new Set(b.allergens))
        await run("INSERT INTO user_allergens VALUES(?,?)", id, Number(a));
    });
  } else if (path === "favorite") {
    check(
      await has(
        "SELECT 1 FROM recipes WHERE recipe_id=? AND (is_approved OR created_by=?)",
        b.recipe_id,
        id,
      ),
      "Recipe not found",
    );
    if (await has("SELECT 1 FROM favorites WHERE user_id=? AND recipe_id=?", id, b.recipe_id))
      await run("DELETE FROM favorites WHERE user_id=? AND recipe_id=?", id, b.recipe_id);
    else await run("INSERT INTO favorites(user_id,recipe_id) VALUES(?,?)", id, b.recipe_id);
  } else if (path === "rating") {
    check(integer(b.rating, 1, 5), "Choose a rating from 1 to 5");
    check(
      typeof b.review === "string" && b.review.length <= 2000,
      "Review is too long",
    );
    check(
      await has("SELECT 1 FROM recipes WHERE recipe_id=? AND is_approved", b.recipe_id),
      "Recipe not found",
    );
    // fn_rate_recipe upserts the rating; a trigger refreshes recipes.avg_rating.
    await one("SELECT fn_rate_recipe(?,?,?,?) AS avg", id, b.recipe_id, Number(b.rating), b.review);
  } else if (path === "recipe") {
    check(
      typeof b.title === "string" &&
        b.title.trim().length > 0 &&
        b.title.length <= 200,
      "Enter a recipe title",
    );
    check(
      typeof b.description === "string" && b.description.length <= 2000,
      "Description is too long",
    );
    check(
      Array.isArray(b.instructions) &&
        b.instructions.length > 0 &&
        b.instructions.every(
          (s: any) =>
            typeof s === "string" && s.trim().length > 0 && s.length < 2000,
        ),
      "Add cooking instructions",
    );
    for (const k of [
      "prep_time_minutes",
      "cook_time_minutes",
      "protein_g",
      "carbs_g",
      "fat_g",
    ])
      check(
        Number.isFinite(Number(b[k])) &&
          Number(b[k]) >= 0 &&
          Number(b[k]) <= 2000,
        "Invalid " + k,
      );
    check(
      integer(b.servings, 1, 50) && integer(b.calories_per_serving, 1, 5000),
      "Invalid servings or calories",
    );
    check(
      (await has("SELECT 1 FROM cuisines WHERE cuisine_id=?", Number(b.cuisine_id))) &&
        (await has("SELECT 1 FROM dietary_types WHERE diet_id=?", Number(b.diet_id))),
      "Invalid cuisine or diet",
    );
    check(
      ["Breakfast", "Lunch", "Dinner"].includes(b.meal_type),
      "Invalid meal type",
    );
    check(
      Array.isArray(b.ingredients) &&
        b.ingredients.length > 0 &&
        (
          await seq(
            b.ingredients,
            async (i: any) =>
              (await has(
                "SELECT 1 FROM ingredients WHERE ingredient_id=?",
                Number(i.ingredient_id),
              )) &&
              Number(i.quantity) > 0 &&
              Number(i.quantity) < 100000,
          )
        ).every(Boolean),
      "Add valid ingredients",
    );
    const fields = [
      "prep_time_minutes",
      "cook_time_minutes",
      "servings",
      "calories_per_serving",
      "protein_g",
      "carbs_g",
      "fat_g",
      "cuisine_id",
      "diet_id",
    ].map((k) => Number(b[k]));
    await transaction(async () => {
      let rid = b.recipe_id;
      if (rid) {
        check(
          await has("SELECT 1 FROM recipes WHERE recipe_id=? AND created_by=?", rid, id),
          "You can only edit your recipes",
        );
        await run("DELETE FROM recipe_ingredients WHERE recipe_id=?", rid);
        await run(
          "UPDATE recipes SET title=?,description=?,instructions=?::jsonb,prep_time_minutes=?,cook_time_minutes=?,servings=?,calories_per_serving=?,protein_g=?,carbs_g=?,fat_g=?,cuisine_id=?,diet_id=?,meal_type=? WHERE recipe_id=?",
          b.title,
          b.description,
          JSON.stringify(b.instructions),
          ...fields,
          b.meal_type,
          rid,
        );
      } else
        // New recipes start unapproved (column default); only an administrator can approve.
        rid = (
          await one(
            "INSERT INTO recipes(title,description,instructions,prep_time_minutes,cook_time_minutes,servings,calories_per_serving,protein_g,carbs_g,fat_g,cuisine_id,diet_id,created_by,meal_type,image,flavor) VALUES(?,?,?::jsonb,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING recipe_id",
            b.title,
            b.description,
            JSON.stringify(b.instructions),
            ...fields,
            id,
            b.meal_type,
            "",
            "savory",
          )
        ).recipe_id;
      for (const i of b.ingredients)
        await run(
          "INSERT INTO recipe_ingredients VALUES(?,?,?,?)",
          rid,
          Number(i.ingredient_id),
          Number(i.quantity),
          "g",
        );
      if ((await one("SELECT is_approved FROM recipes WHERE recipe_id=?", rid))?.is_approved)
        await enqueueVector(Number(rid), "upsert");
    });
  } else if (path === "recipe-delete") {
    check(
      await has("SELECT 1 FROM recipes WHERE recipe_id=? AND created_by=?", b.recipe_id, id),
      "You can only delete your recipes",
    );
    await transaction(async () => {
      if ((await one("SELECT is_approved FROM recipes WHERE recipe_id=?", b.recipe_id))?.is_approved)
        await enqueueVector(Number(b.recipe_id), "delete");
      await run("DELETE FROM recipes WHERE recipe_id=?", b.recipe_id);
    });
    await syncOutbox();
  } else if (path === "plan-delete") {
    await run("DELETE FROM meal_plans WHERE plan_id=? AND user_id=?", b.plan_id, id);
  } else if (path === "plan") {
    check(
      typeof b.start_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(b.start_date) &&
        !isNaN(Date.parse(b.start_date)) &&
        new Date(b.start_date + "T12:00:00Z").toISOString().slice(0, 10) ===
          b.start_date,
      "Choose a valid start date",
    );
    // Stored procedure: diet + allergen filtering, calorie targeting and the 21 meal rows.
    await run("CALL sp_generate_meal_plan(?, ?::date, NULL)", id, b.start_date);
  } else return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

function friendly(e: any): string {
  // Translate database error codes into messages a user can act on.
  // 23001 = ON DELETE RESTRICT violation, 23503 = FK violation
  if (["23001", "23503"].includes(e?.code) && /meal_plan_recipes/.test(e.message || ""))
    return "This recipe is used in a meal plan. Remove it from plans first.";
  if (e?.code === "42501" || /row-level security/.test(e?.message || ""))
    return "You do not have permission to do that";
  return e instanceof Error ? e.message : "Request failed";
}

async function handle(req: NextRequest) {
  try {
    const path = req.nextUrl.pathname.replace("/api/", "");
    let b: any = null;
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (origin && new URL(origin).host !== req.headers.get("host"))
        return NextResponse.json(
          { error: "Invalid request origin" },
          { status: 403 },
        );
      b = await req.json();
    }
    if (path === "auth" && req.method !== "GET") {
      // Pre-authentication work runs as the rr_app login role (users + sessions only).
      const result = await asRole(null, null, () => authenticate(req, b));
      if (result instanceof NextResponse) return result;
      const { account, token } = result;
      const payload = await asRole(roleOf(account), account.user_id, () =>
        safe(account),
      );
      const r = NextResponse.json({ user: payload });
      r.cookies.set("rr_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 604800,
      });
      return r;
    }
    const u = await user(req);
    // Every other request runs in ONE transaction under the caller's database role.
    return await asRole(roleOf(u), u?.user_id ?? null, () =>
      dispatch(req, path, u, b),
    );
  } catch (e) {
    return NextResponse.json({ error: friendly(e) }, { status: 400 });
  }
}
export const GET = handle;
export const POST = handle;
