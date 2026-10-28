# Storage query performance: `$or` lookups

Work notes from October 2026. They record what we found, what we changed, and what is still open.

## Status

| Item | Where | State | Next step |
| ---- | ----- | ----- | --------- |
| Credo PR [#3135](https://github.com/openwallet-foundation/credo-ts/pull/3135) (split `findByDids` into 3 queries) | upstream | Open, by another author | Do not merge it. Reply after the Askar fix is released (see [Credo PR #3135](#credo-pr-3135)). |
| Askar fix for tag filters | `~/dev/askar`, branch `fix/tag-filter-or-query-plan`, commits `e195079` and `d5612d4` | Done, tested | Open the Askar PR. Update the PR body with the final numbers in this file. |
| Askar release for Credo | Askar and `askar-nodejs` | Not started | Release Askar, then update the native binary version that Credo uses (now `v0.5.0` through `askar-nodejs` 0.6.1). |
| Drizzle indexes and array queries | `credo-ts`, branch `fix/drizzle-indexes`, commit `2bb0b1d48` | Done, tested | Fix or remove `packages/askar/src/__tests__/or-query-bench.e2e.test.ts` (see [Open items](#open-items)), then open the PR. |

## Background

Credo calls `DidCommConnectionService.findByKeys` for each received authcrypted DIDComm message. It makes 3 storage lookups:

1. `Did` with role `received`, by recipient key fingerprint
2. `Did` with role `created`, by recipient key fingerprint
3. `DidCommConnectionRepository.findByDids`: one query with a 3-branch `$or` on `did`, `theirDid`, `previousDids` and `previousTheirDids`

The envelope service also finds a created `Did` by recipient key for each message. A mediator also finds a `DidcommMediation` record by recipient key for each forward message.

PR #3135 says that the `$or` query is slow at scale, and replaces it with 3 separate queries. Usually one `$or` query is faster than separate queries, so we analyzed why that was not true here.

## Findings

### Askar on PostgreSQL

Askar keeps tags in the `items_tags` table. Each tag condition becomes `i.id IN (SELECT item_id FROM items_tags WHERE ...)`.

- PostgreSQL can turn `IN (subquery)` conditions into joins only at the top level of the `WHERE` clause. Under an `OR`, it cannot do this. It uses hashed subplans and reads all rows of the `items` table, for all profiles and categories.
- A single query without `OR` uses the tag index, and its time does not change with the number of records.
- Thus the claim in PR #3135 is correct for Askar on PostgreSQL. The cause is the SQL that Askar generates, not the `$or` query itself.

### Askar on SQLite

Askar never runs `ANALYZE`. Without statistics, SQLite thinks that `profile_id = ?` selects few rows, and it starts from the profile index. All items of a wallet have the same profile, so each tag query reads all items of the profile. This is true for single queries and for `$or` queries. Thus PR #3135 makes SQLite about 2 times slower.

### Askar generic plans (older problem, found during the work)

After 5 executions of a prepared statement, PostgreSQL can use a generic plan without the parameter values. The generic plan estimates 1 row for each tag subquery and starts from the first subquery.

- `{ state: 'completed', theirDid: X }` took 750 ms on `main` with 100k records, because `state` matched all items.
- The result depends on the order of the tags. `did` + `state` was fast.
- Filters with the same structure give the same SQL text and share one cached statement. Thus one filter can make a different filter use the bad plan.

### Drizzle

- The Drizzle schema has no secondary indexes. Each lookup by tag reads all rows of the tenant in the table.
- The PostgreSQL query builder wrote array tags as `to_jsonb(col) @> to_jsonb(array[$1])`. No index can serve this expression, and PostgreSQL does not accept `to_jsonb` in an index expression (the function is not `IMMUTABLE`).
- With plain columns in one table, the `$or` query is the fast form: PostgreSQL uses a `BitmapOr` over the indexes.
- Drizzle with `node-postgres` sends unnamed statements, so the generic plan problem does not occur.

## Changes

### Askar (`~/dev/askar`, branch `fix/tag-filter-or-query-plan`)

1. `askar-storage/src/wql/sql.rs`: if each branch of an OR has a positive tag match, the encoder writes one `i.id IN (... UNION ALL ...)` condition. An AND in such an OR becomes `SELECT i.id FROM items i WHERE ...`. Plain AND filters, and OR filters with a branch without a positive match, keep the old SQL. A union with more than 400 terms is split into nested `SELECT * FROM (...) AS u` groups, because SQLite accepts at most 500 terms in one compound SELECT.
2. `askar-storage/src/backend/sqlite/mod.rs`: when the tag filter has a positive match, the scan, count and delete-all queries use `+i.profile_id`. This stops SQLite from using the profile index.
3. `askar-storage/src/backend/postgres/mod.rs`: a query with more than one positive tag match runs as an unnamed statement. PostgreSQL then plans it with the parameter values each time. This fixes the generic plan problem. It adds about 1 ms of planning to each multi-tag query.

### Credo Drizzle storage (branch `fix/drizzle-indexes`)

1. `packages/drizzle-storage/src/adapter/queryToDrizzlePostgres.ts`: array columns use `arrayContains` (`col @> $1`), and `jsonb` columns use `col @> $1::jsonb`. A GIN index can serve both forms. Other column types keep the old `to_jsonb` form.
2. New indexes, with migrations `core/postgres/0006_add_lookup_indexes.sql`, `didcomm/postgres/0002_add_lookup_indexes.sql` and `didcomm/sqlite/0002_add_lookup_indexes.sql`:

   | Table | PostgreSQL | SQLite |
   | ----- | ---------- | ------ |
   | `DidcommConnection` | btree `(context_correlation_id, did)` and `(context_correlation_id, their_did)` | same |
   | `Did` | GIN `(recipient_key_fingerprints jsonb_path_ops)` | none |
   | `DidcommMediation` | GIN `(recipient_keys)` | none |
   | `DidcommOutOfBand` | GIN `(recipient_key_fingerprints)` and btree `(context_correlation_id, recipient_routing_key_fingerprint)` | btree on the routing key only |

3. Changeset: `.changeset/drizzle-lookup-indexes.md`.

## Results

All values are means of 200 lookups, in ms, unless the text says otherwise. The test environment is in [Test environment](#test-environment).

### Askar: `findByDids` `$or` query

| Backend | Records | `main`, `$or` | `main`, 3 queries (PR #3135) | Fix (`d5612d4`), `$or` |
| ------- | ------- | ------------- | ---------------------------- | ---------------------- |
| PostgreSQL | 1k | 0.88 | 0.83 | 2.40 |
| PostgreSQL | 10k | 3.17 | 0.87 | 2.64 |
| PostgreSQL | 100k | 81.1 (p95 367) | 1.25 | 2.85 |
| SQLite | 1k | 0.46 | 0.82 | 0.36 |
| SQLite | 10k | 1.64 | 3.49 | 0.39 |
| SQLite | 100k | 16.4 | 36.2 | 0.40 |

- On PostgreSQL, the fixed `$or` query is slower than `main` at 1k records (0.88 to 2.40 ms). The cause is the planning for each execution (change 3). Without change 3, the fixed query took 0.73 to 0.85 ms, but the generic plan problem stays.
- At 100k records, the `main` `$or` query has a large p95, because the `items` table (130 MB) is larger than `shared_buffers` (128 MB).

### Askar: other cases

| Case | `main` | Fix |
| ---- | ------ | --- |
| PostgreSQL 100k, `{ state: 'completed', theirDid }` | 750 ms | 1.2 ms |
| SQLite 10k, `$or` with 600 terms | 236 ms | 59 ms |
| PostgreSQL 10k, `$or` with 600 terms | 4.1 s | 123 ms |
| Filters that match most records (`state=completed`, `NOT role`, with a limit) | no change | no change |

### Drizzle on PostgreSQL: `findByKeys` (100k connections, 200k DIDs)

| Step | Before | New query builder only | Query builder and indexes |
| ---- | ------ | ---------------------- | ------------------------- |
| `Did` received by key | 33.0 | 19.1 | 0.56 |
| `Did` created by key | 32.6 | 19.0 | 0.52 |
| Connection `$or` | 30.9 | 17.2 | 1.03 |
| Total | 96.4 | 55.3 | 2.1 |

With the indexes, the `$or` query (0.65 ms) is also faster than the 3 queries of PR #3135 (1.32 ms).

### Test environment

- AMD Ryzen 9 5950X (16 cores, 32 threads), 64 GB RAM, NVMe SSD, Manjaro Linux (kernel 6.18), Node.js 24
- PostgreSQL 18.6 in Docker (`postgres:18.6-alpine`), default configuration, `ANALYZE` before each run
- SQLite as bundled by `libsqlite3-sys` 0.37. The database files were on tmpfs (RAM).
- Askar: release builds of `main` (`b9bf502`) and of the fix branch, Rust 1.94, loaded through `askar-nodejs` 0.6.1
- Data: one profile or tenant, connection records with 6 tags, 5% with rotated DIDs. Lookups: 50% current DIDs, 25% rotated DIDs, 25% no match. One client, warm cache.

## Tests that we did

- Askar: `cargo test --workspace --features pg_test` on SQLite and PostgreSQL. The new tests are in `wql/sql.rs` and `tests/utils/mod.rs` (`db_scan_or_many_terms`, 1,201 terms). rustfmt and clippy are clean.
- Askar: 400 random nested WQL queries (`$or`, `$and`, `$not`, `$neq`, `$in`, `$exist`) gave the same result sets with `main` and with the fix, on both backends.
- Credo with the fixed Askar library (`LIB_ASKAR_PATH`): the unit (2,949 tests), e2e (200 tests) and drizzle (63 tests) projects pass.
- Drizzle: the drizzle test project passes. The migration CLI applies the full chain on empty PostgreSQL and SQLite databases. The new PostgreSQL migrations also apply to a database with 100k connections.

## How to repeat the tests

The benchmark scripts are in a temporary directory, and a reboot deletes them. To repeat the work, use the steps below.

1. Start a separate PostgreSQL for benchmarks, with `auto_explain` to see the plans:

   ```sh
   docker run -d --name askar-or-bench -p 55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     postgres:18.6-alpine -c shared_preload_libraries=auto_explain -c auto_explain.log_min_duration=-1 \
     -c auto_explain.log_analyze=on
   ```

   To log plans for one database only: `ALTER DATABASE <db> SET auto_explain.log_min_duration = 0`. Then read `docker logs askar-or-bench`.

2. Build Askar without a local Rust toolchain:

   ```sh
   docker run --rm --user $(id -u):$(id -g) -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target \
     -v <cargo-cache-dir>:/cargo -v <target-dir>:/target -v ~/dev/askar:/src:ro -w /src \
     rust:1.94-bookworm cargo build --lib --release
   ```

   The library is `<target-dir>/release/libaries_askar.so`. For `cargo test`, mount a writable copy of the source, because some SQLite tests write files. Add `--network host` and `-e POSTGRES_URL=postgres://postgres:postgres@localhost:55432/test-db --features pg_test` for the PostgreSQL tests. The `rust` image does not include rustfmt and clippy. Install them with `rustup component add rustfmt clippy`.

3. Use a local Askar build in Credo: set `LIB_ASKAR_PATH` to the directory of `libaries_askar.so`. To make sure that the variable is used, point it to a directory with an empty `libaries_askar.so`. The Askar tests must then fail.

4. Benchmark Askar directly: open a store with `Store.provision` from `@openwallet-foundation/askar-nodejs`, insert records in transactions of 1,000, and time `new Scan({ store, category, tagFilter }).fetchAll()`. Use the same tag encoding as Credo (`packages/askar/src/storage/utils.ts`). An array tag `previousDids: [x]` becomes the tag `previousDids:x` with the value `1`. Run `ANALYZE` on PostgreSQL after the inserts, because tables without statistics give wrong results.

5. Benchmark Drizzle: apply the migration SQL files to a new database, and seed rows with `generate_series` in SQL. Time the real adapters (`DrizzleDidRecordAdapter`, `DrizzleDidcommConnectionRecordAdapter`) in a temporary `*.drizzle.e2e.test.ts` file. The project test setup hides `console.log`, so write the results to a file.

6. Run the Credo suite as CI does: `docker compose up -d --wait`, `pnpm --filter @credo-ts/drizzle-storage run build`, then `pnpm test:unit`, `pnpm test:e2e` and `pnpm test:drizzle`.

## Rejected alternatives

| Alternative | Reason |
| ----------- | ------ |
| 3 separate queries (PR #3135) | 2 times slower on SQLite. Slower than the fixed `$or` query on Drizzle with indexes. It also does not fix other `$or` queries. |
| `INTERSECT` for AND clauses in an OR | Reads all rows of a common tag such as `state=completed`. |
| Run `ANALYZE` in Askar for SQLite | Needs a refresh strategy. The `+i.profile_id` hint gives the same plans now. |
| `plan_cache_mode = force_custom_plan` on the connection | Same cost as unnamed statements, and it also makes single-tag queries slower. |
| Expression index on `to_jsonb(col)` in Drizzle | PostgreSQL rejects it, because `to_jsonb` is not `IMMUTABLE`. |
| Fallback to the old SQL for an OR above 400 terms | Correct, but PostgreSQL then uses the slow plan. Nested union groups keep the fast plan on both backends. |

## Open items

1. **The Credo branch has a broken file.** Commit `2bb0b1d48` includes `packages/askar/src/__tests__/or-query-bench.e2e.test.ts`. Line 108 ends with `else` and no statement, so `pnpm types:check` and `pnpm style:check` fail. The file says that it is temporary and not part of the suite. Remove it from the commit, or fix it and move it to a place that CI does not run.
2. **Askar PR body:** the draft body has old PostgreSQL numbers (0.73 to 0.85 ms). Use the numbers in this file. Add short sections about the generic plan change and about large OR filters.
3. **Askar commit split (optional):** the unnamed statement change is in `e195079` together with the OR change. If the PR is not squash-merged, a separate commit makes the trade-off easier to review.
4. **Askar code comment (optional):** the comment in `perform_scan` uses Credo tag names (`did`, `state`, `theirDid`). A general text is better in Askar.
5. **Askar patch release:** the patch applies to `v0.5.0` with `git apply --3way`. We did not build or test it on `v0.5.0`.
6. **Drizzle migration lock:** `CREATE INDEX` blocks writes to the table during the build. With 200k `Did` rows the build took 1.9 s. The changeset tells users to migrate at a time with little traffic.
7. **Not measured:** the `DidcommMediation` and `DidcommOutOfBand` indexes, the cost of the new indexes for inserts and updates, and Drizzle on SQLite.
8. **No direct test for the `jsonb` array query:** no Drizzle test calls the `Did` lookup by recipient key directly. The DIDComm flows on Drizzle PostgreSQL and the benchmark cover it.
9. **Other Drizzle lookups without indexes:** for example `Did` by `did`, and custom tag queries (`custom_tags ->> 'field'`). They are not in the message path that we analyzed.

## Credo PR #3135

Recommended reply to the author, after the Askar release:

- On Askar PostgreSQL the analysis is correct, but the cause is the SQL that Askar generates for `$or`. The Askar fix makes the single query fast, and the cost no longer changes with the number of records.
- On Askar SQLite the 3 queries are about 2 times slower than the current `$or` query.
- On Drizzle, the cause is missing indexes. With the new indexes, the `$or` query is faster than the 3 queries.
- Thus we keep the `$or` query in `findByDids`.
