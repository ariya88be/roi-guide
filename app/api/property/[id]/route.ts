/**
 * GET /api/property/[id] — full ROI breakdown for the detail card.
 *
 * Note (Next.js 16): route `params` is now a Promise and must be awaited.
 */
import { queryPropertyDetail } from "@/lib/pins/query";
import { parseAssumptions } from "@/lib/http/pinsParams";
import { rateLimit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = await rateLimit(`detail:${clientIp(req)}`, 120, 60);
  if (!rl.ok) return Response.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const opts = parseAssumptions(new URL(req.url).searchParams);
    const detail = await queryPropertyDetail(id, opts);
    if (!detail) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(detail);
  } catch (err) {
    console.error("[/api/property] query failed:", (err as Error)?.message);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
