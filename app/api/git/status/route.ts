import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { guardSession } from "@/lib/users/access";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("sessionId");
    // A member may only read workspaces of sessions they own; cwd-only reads stay open.
    if (sessionId !== null) {
      const denied = guardSession(request, sessionId);
      if (denied) return denied;
    }
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, sessionId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.gitStatus(resolved.cwd ?? params.get("cwd")?.trim() ?? "", resolved.owner);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) { return apiErrorResponse(error); }
}
