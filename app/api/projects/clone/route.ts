import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { CloneProgress } from "@/lib/git-clone";
import { canSeeProject, claimProject } from "@/lib/users/access";

export async function POST(request: Request, { disableIdleTimeout }: { disableIdleTimeout: () => void }) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.id !== "string" || typeof body.parent !== "string" || typeof body.url !== "string") return Response.json({ error: "Invalid clone request", code: "invalid_request" }, { status: 400 });
    // A member may only clone into a project they can see; invisible keys are the same 404 the projects routes answer.
    if (!canSeeProject(request, body.id)) return Response.json({ error: "Registered project not found", code: "project_not_found" }, { status: 404 });
    const resolved = await resolveWorkspaceHost(body.hostId, null, { request });
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    const id = body.id;
    let active = true;
    const cancel = () => { void host.workspaceOps.cancelClone(id).catch(() => {}); };
    const started = await host.workspaceOps.startClone(id, body.parent, body.url.trim());
    if (!started.ok) { request.signal.removeEventListener("abort", cancel); return opErrorResponse(started); }
    // Phase 3: the cloned project's identity belongs to the member who started it.
    claimProject(request, id);
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    let cursor = 0;
    const encoder = new TextEncoder();
    disableIdleTimeout();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let page: CloneProgress;
          do {
            const result = await host.workspaceOps.readClone(id, cursor);
            if (!active) return;
            if (!result.ok) throw new Error(result.error);
            page = result.value;
          } while (!page.terminal && page.frames.length === 0);
          cursor = page.cursor;
          if (page.reset) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "output", text: "", reset: true })}\n`));
          for (const frame of page.frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          if (page.terminal) { active = false; request.signal.removeEventListener("abort", cancel); controller.close(); }
        } catch {
          if (!active) return;
          active = false;
          request.signal.removeEventListener("abort", cancel);
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: "clone_uncertain", error: "The clone connection was interrupted; its outcome is unknown. Check the destination before retrying." })}\n`));
          controller.close();
        }
      },
      cancel() { active = false; request.signal.removeEventListener("abort", cancel); cancel(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.id !== "string") return Response.json({ error: "Invalid clone request", code: "invalid_request" }, { status: 400 });
    // Cancelling another member's clone must fail exactly like fetching an invisible project.
    if (!canSeeProject(request, body.id)) return Response.json({ error: "Registered project not found", code: "project_not_found" }, { status: 404 });
    const resolved = await resolveWorkspaceHost(body.hostId, null, { request });
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.cancelClone(body.id);
    return result.ok ? Response.json({ ok: true, ...result.value }) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error, error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500);
  }
}
