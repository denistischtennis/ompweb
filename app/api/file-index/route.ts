import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { guardSession } from "@/lib/users/access";
import { parseResultLimit } from "@/lib/file-fuzzy";



export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const sessionId = params.get("sessionId");
    // A member may only read workspaces of sessions they own; cwd-only reads stay open.
    if (sessionId !== null) {
      const denied = guardSession(req, sessionId);
      if (denied) return denied;
    }
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, sessionId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.fileIndex(
      resolved.cwd ?? params.get("cwd")?.trim() ?? "", params.get("q") ?? "", parseResultLimit(params.get("limit")),
      params.get("kind") === "file" ? "file" : "all", params.get("refresh") === "1", resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
