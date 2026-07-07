/**
 * GET /api/pins — GeoJSON of cash-flow pins for the current viewport.
 *
 * Public read endpoint: rate-limited (brief §9), input-validated with Zod,
 * generic errors to the client (details stay in server logs). Provider/DB keys
 * never reach here — all data comes from our own database via the server-only
 * query layer.
 */
import { parsePinsParams } from "@/lib/http/pinsParams";
import { queryPins } from "@/lib/pins/query";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const rl = await rateLimit(`pins:${clientIp(req)}`, 120, 60);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } },
    );
  }

  const parsed = parsePinsParams(new URL(req.url).searchParams);
  if (!parsed.success) {
    return Response.json({ error: "Invalid parameters" }, { status: 400 });
  }

  try {
    const fc = await queryPins(parsed.data);
    return Response.json(fc, { headers: { "Cache-Control": "private, max-age=15" } });
  } catch (err) {
    console.error("[/api/pins] query failed:", (err as Error)?.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
