/**
 * LIVE database integration tests (QA §15.H geospatial, §15.M isolation).
 *
 * These run only when APP_DATABASE_URL is set (the non-superuser `roi_app`
 * connection). Without it — e.g. a CI job with no database — the whole suite is
 * skipped, keeping the pure unit suite offline and fast. Run locally with:
 *   set -a && . ./.env.local && set +a && npm test
 *
 * They connect as `roi_app` on purpose: RLS is only meaningful for a
 * non-superuser role, so testing through it proves the policies actually bite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const APP_URL = process.env.APP_DATABASE_URL;
const live = APP_URL ? describe : describe.skip;

// Unique per-run prefix so parallel/rerun test rows never collide.
const RUN = `itest-${process.pid}-${Date.now()}`;

live("geospatial via PostGIS (live, QA §15.H)", () => {
  let sql: postgres.Sql;
  // Koreatown-ish points: A & B inside the test envelope, C far outside.
  const A = { id: `${RUN}-A`, lng: -118.3, lat: 34.06 };
  const B = { id: `${RUN}-B`, lng: -118.31, lat: 34.07 };
  const C = { id: `${RUN}-C`, lng: -118.5, lat: 34.2 };

  beforeAll(async () => {
    sql = postgres(APP_URL!, { ssl: false, max: 1 });
    for (const p of [A, B, C]) {
      await sql`
        insert into properties (rentcast_id, location, city, state)
        values (${p.id}, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326), 'Los Angeles', 'CA')`;
    }
  });

  afterAll(async () => {
    await sql`delete from properties where rentcast_id like ${RUN + "%"}`;
    await sql.end();
  });

  it("bounding-box query returns exactly the properties inside the envelope", async () => {
    const rows = await sql`
      select rentcast_id from properties
      where rentcast_id like ${RUN + "%"}
        and location && ST_MakeEnvelope(-118.32, 34.05, -118.29, 34.08, 4326)
      order by rentcast_id`;
    expect(rows.map((r) => r.rentcast_id)).toEqual([A.id, B.id]);
  });

  it("radius query (ST_DWithin over geography) returns the correct nearby set, nearest first", async () => {
    const rows = await sql`
      select rentcast_id,
             ST_Distance(location::geography, ST_SetSRID(ST_MakePoint(${A.lng}, ${A.lat}), 4326)::geography) as meters
      from properties
      where rentcast_id like ${RUN + "%"}
        and ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint(${A.lng}, ${A.lat}), 4326)::geography, 3000)
      order by meters`;
    // A (distance 0) and B (~1.4 km) are within 3 km; C is not.
    expect(rows.map((r) => r.rentcast_id)).toEqual([A.id, B.id]);
    expect(Number(rows[0].meters)).toBeCloseTo(0, 3);
  });

  it("uses the GiST index for the bounding-box query", async () => {
    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx`explain (format json)
        select 1 from properties
        where location && ST_MakeEnvelope(-118.32, 34.05, -118.29, 34.08, 4326)`;
    });
    const planText = JSON.stringify(plan);
    expect(planText).toContain("properties_location_gix");
  });
});

live("row-level security / per-user isolation (live, QA §15.M)", () => {
  let sql: postgres.Sql;
  const u1 = `${RUN}-u1`;
  const u2 = `${RUN}-u2`;
  let search1Id = "";
  let search2Id = "";

  /** Run `fn` in a transaction scoped to `userId` via app.user_id (like db/client withUser). */
  async function asUser<T>(userId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      return fn(tx as unknown as postgres.Sql);
    }) as Promise<T>;
  }

  async function seedUser(userId: string): Promise<string> {
    return asUser(userId, async (tx) => {
      await tx`insert into users (id, email) values (${userId}, ${userId + "@test.local"})`;
      const [row] = await tx`
        insert into saved_searches (user_id, name, mode, min_monthly_cash_flow)
        values (${userId}, 'my search', 'budget_return', 1000)
        returning id`;
      return row.id as string;
    });
  }

  beforeAll(async () => {
    sql = postgres(APP_URL!, { ssl: false, max: 1 });
    search1Id = await seedUser(u1);
    search2Id = await seedUser(u2);
  });

  afterAll(async () => {
    // Delete each user's own rows within their own RLS scope (cascades to searches).
    for (const uid of [u1, u2]) {
      await asUser(uid, async (tx) => {
        await tx`delete from saved_searches where user_id = ${uid}`;
        await tx`delete from users where id = ${uid}`;
      });
    }
    await sql.end();
  });

  it("a user sees only their own saved searches", async () => {
    const rows = await asUser(u1, (tx) => tx`select id, user_id from saved_searches`);
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(u1);
    expect(rows[0].id).toBe(search1Id);
  });

  it("IDOR: cannot SELECT another user's row even by exact id", async () => {
    const rows = await asUser(u1, (tx) => tx`select * from saved_searches where id = ${search2Id}`);
    expect(rows.length).toBe(0);
  });

  it("IDOR: cannot UPDATE another user's row", async () => {
    const res = await asUser(u1, (tx) => tx`update saved_searches set name = 'hacked' where id = ${search2Id}`);
    expect(res.count).toBe(0);
    // Confirm u2's row is untouched, viewed in u2's own scope.
    const [row] = await asUser(u2, (tx) => tx`select name from saved_searches where id = ${search2Id}`);
    expect(row.name).toBe("my search");
  });

  it("fail-closed: a connection with no app.user_id set sees zero rows", async () => {
    const rows = await sql`select * from saved_searches where user_id in (${u1}, ${u2})`;
    expect(rows.length).toBe(0);
  });
});
