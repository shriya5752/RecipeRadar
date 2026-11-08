# RecipeRadar

RecipeRadar is a full-stack recipe discovery and meal-planning application built as a DBMS Level 3 project. The database is the focus: a PostgreSQL schema with keys, constraints, triggers, views, a stored procedure, full-text search, an in-database vector index, and **database-enforced roles** (GRANT/REVOKE, column privileges and row-level security) behind a Next.js interface and API.

## Contents

- [Features](#features) · [Technology stack](#technology-stack) · [Run locally](#run-locally) · [Run with Docker](#run-with-docker)
- [Database design](#database-design) · [SQL work](#sql-work) · [Vector search and RUD](#vector-search-and-rud)
- [Authentication and database roles](#authentication-and-database-roles) · [API](#api) · [Tests](#tests) · [Project report](#project-report-and-evidence) · [Limitations](#limitations)

## Features

- Search and filter recipes by cuisine, diet, calories, ingredients and flavor; ranked full-text search.
- Register and log in; save favorites, rate recipes, record allergies, and generate meal plans (a PostgreSQL stored procedure).
- Scale nutrition and shopping-list quantities by planned servings.
- Submit recipes for admin review; administrators approve/reject submissions and manage roles; privileged changes are audited.
- Rank recipes by flavor similarity with 128-dimensional embeddings and cosine similarity computed inside PostgreSQL.

## Technology stack

| Layer | Technology |
| --- | --- |
| Frontend and API | Next.js 16 App Router, React 19, TypeScript, Route Handlers |
| Relational database | PostgreSQL 15+ (tested on 18), accessed with `pg` |
| Vector database | `float8[128]` embeddings in PostgreSQL searched by `fn_search_vectors()`; optional Qdrant via `QDRANT_URL` |
| Authentication | Salted scrypt password hashes, random opaque session cookie, SHA-256 session-token hashes in the database |

**Why these choices.** Recipes, ingredients, allergens, ratings and plans are strongly relational and need foreign keys, transactions and constraints, so PostgreSQL is the system of record. Flavor similarity is a nearest-neighbour problem over embeddings; keeping the vectors in PostgreSQL means they share transactions with the recipes they describe (no dual-write inconsistency) and the 12-to-thousands scale of a recipe catalogue does not need a separate service. Qdrant remains available for larger deployments.

## Run locally

Requirements: Node.js 22.6+ and a PostgreSQL 15+ server where you can create a database.

```bash
createdb reciperadar                      # or: psql -c "CREATE DATABASE reciperadar"
cp .env.example .env.local                # edit the passwords/URLs; never commit real secrets
npm install
npm run db:setup                          # applies db/migrations/*.sql, creates roles, seeds demo data
npm run dev                               # http://localhost:3000
```

`npm run db:setup` reads `DATABASE_ADMIN_URL` (owner connection) and `RR_APP_PASSWORD` from the environment (export them or use `node --env-file=.env.local`). The app itself connects as the low-privilege `rr_app` role through `DATABASE_URL`. Setup is idempotent: applied migrations are recorded in `schema_migrations`, and demo data is inserted only into an empty database.

Demo accounts (local only; override with `SEED_DEMO_PASSWORD` / `SEED_ADMIN_PASSWORD`, skip with `SEED_DEMO=0`):

- User: `demo@reciperadar.app` / `RecipeRadar123!`
- Admin: `admin@reciperadar.app` / `AdminRadar123!`

Production build: `npm run build && npm start`.

## Run with Docker

```bash
printf 'POSTGRES_PASSWORD=change-me\nRR_APP_PASSWORD=change-me-too\n' > .env
docker compose up --build                 # app on http://localhost:3000, PostgreSQL 17 behind it
```

The container runs `npm run db:setup` before starting the server.

## Database design

18 tables: the 13 tables of the supplied relational model plus `ingredient_allergens`, `sessions`, `vector_sync_outbox`, `vector_documents` and `audit_log`.

- Primary keys on every table (composite for join tables); foreign keys with explicit `ON DELETE` behaviour.
- `NOT NULL`, `UNIQUE` (case-insensitive via `lower()` indexes), `CHECK`, `NUMERIC(p,s)`, `DATE`, `JSONB` and array-dimension constraints protect data even when writes bypass the app.
- 12 PL/pgSQL triggers: derived `avg_rating` and `is_common_allergen`, meal dates inside the plan range, recipe-step validation, last-administrator protection, and the audit log.
- Views: `recipe_allergen_details`, `meal_plan_daily_nutrition`, `meal_plan_shopping_list`, `my_profile`.
- Versioned migrations in `db/migrations/`: `001_schema`, `002_routines`, `003_full_text_search` (an `ALTER TABLE` adding a generated `tsvector` + GIN index), `004_roles_and_security`.

Diagrams: [`docs/figures/er-diagram.png`](docs/figures/er-diagram.png), editable [`docs/figures/reciperadar-erd.drawio`](docs/figures/reciperadar-erd.drawio), [`docs/figures/relational-schema.png`](docs/figures/relational-schema.png). Reconciliation with the supplied model: [`docs/database-audit.md`](docs/database-audit.md). The previous SQLite implementation is archived in `db/legacy-sqlite/`.

## SQL work

[`db/queries.sql`](db/queries.sql) is runnable (`psql "$DATABASE_ADMIN_URL" -f db/queries.sql`, rolled back at the end) and demonstrates joins, `GROUP BY/HAVING`, subqueries, correlated `NOT EXISTS`, a CTE, two recursive CTEs (substitution chains, plan dates), a window function, DML in a transaction, full-text and vector search, and a role-based-access demo.

Routines (`db/migrations/002_routines.sql`): the stored procedure **`sp_generate_meal_plan(user, start)`** and functions `fn_portion_calories`, `fn_flavor_similarity`, `fn_cosine_similarity`, `fn_search_vectors`, `fn_recipe_allergens`, `fn_safe_recipes`, `fn_search_recipes`, `fn_rate_recipe`.

```bash
npm run db:audit            # consistency checks; add `-- out.json` to save a report
npm run db:backup           # pg_dump to backups/
```

## Vector search and RUD

Each approved recipe has a normalised 128-number embedding: title, description, cuisine, diet, meal type, ingredient names and flavor tags are hashed (SHA-256 feature hashing with a synonym map) into signed buckets and L2-normalised. Search ranks stored vectors by cosine similarity (`fn_search_vectors`). This is an explainable baseline, not a trained language model.

`POST /api/vector` supports `search`, `read`, `upsert` and `delete`; `GET /api/vector` returns backend and index status. A transactional `vector_sync_outbox` makes recipe changes durable before the index is updated (and keeps an optional Qdrant collection in sync). Unapproved drafts are never searchable.

## Authentication and database roles

The API authenticates the session cookie, then runs the **whole request in one transaction under a database role** (`SET LOCAL ROLE`, plus `rr.user_id` for policies and auditing):

| Role | Who | Database privileges |
| --- | --- | --- |
| `rr_guest` | anonymous visitor | read approved recipes, lookups, reviews; no writes |
| `rr_user` | signed-in user | guest + own favorites, ratings, allergies, plans and recipes (row-level security); cannot change `users.role` or `recipes.is_approved` |
| `rr_admin` | administrator | user + approve/reject recipes, change roles, read `audit_log` |
| `rr_app` | login role (`NOINHERIT`) | only `users` + `sessions` until it switches role |

So a bug or injection in the API cannot, for example, let a plain user approve a recipe or read another user's plans: PostgreSQL refuses. Session cookies are HTTP-only and same-site; only a SHA-256 hash of the token is stored. A trigger prevents demoting the last administrator.

Promote an existing account (owner connection): `npm run db:promote-admin -- user@example.com`.

## API

All write routes accept JSON and return `{ "ok": true }` or `{ "error": "..." }`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | Recipes, lookups, current account |
| POST | `/api/auth` | Register, log in, log out |
| POST | `/api/profile` | Profile, calorie target, allergy preferences |
| POST | `/api/favorite` · `/api/rating` | Toggle favorite · add/update rating |
| POST | `/api/recipe` · `/api/recipe-delete` | Submit/update/delete an owned recipe |
| GET | `/api/reviews/:id` · `/api/substitutions` · `/api/search?q=` | Reviews · swaps with allergy conflicts · full-text search |
| GET/POST | `/api/plans` · `/api/plan` · `/api/plan-delete` | Meal plans (`plan` calls the stored procedure) |
| GET/POST | `/api/vector` | Index status and vector RUD/search |
| GET/POST | `/api/admin/recipes` · `/api/admin/review` · `/api/admin/role` | Admin-only moderation and roles |

## Tests

```bash
export DATABASE_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres
npm test                    # 18 database tests on a throwaway database (real PostgreSQL, no mocks)
npm run dev &               # then, against the running app:
npm run test:api            # HTTP suites: CRUD/ownership/planning and roles/moderation/vector/full-text
```

Latest recorded run: [`docs/test-results.txt`](docs/test-results.txt).

## Project report and evidence

[`docs/RecipeRadar_DBMS_Project_Report.docx`](docs/RecipeRadar_DBMS_Project_Report.docx) follows the course template (problem statement, technology justification, ER and relational models, DDL/DML, vector commands, results, project tree, screenshots, rubric status). `scripts/generate-*.py` regenerate the diagrams, evidence images and report from a live database.

## Limitations

Academic project: nutrition values and sample recipes are illustrative; allergen checks cover only explicitly mapped ingredients and cannot detect package warnings or cross-contact. Embeddings are curated-tag feature hashing, not a trained model. Qdrant integration is provided but was not exercised in the test environment. Production use would need secret rotation, password recovery, rate limiting and monitoring.
