import type { FastifyReply, FastifyRequest } from "fastify";

let busy = false;
let pendingRestore = false;
const writes = new Set<FastifyRequest>();
const isTransfer = (path: string) => /^\/api\/ios\/(?:backup|restore)(?:\/|$)/u.test(path);

export function setIosRestorePending(value: boolean) {
  pendingRestore = value;
}

export async function iosMaintenanceHook(request: FastifyRequest, reply: FastifyReply) {
  const path = request.url.split("?", 1)[0] ?? "";
  if (!path.startsWith("/api/") || isTransfer(path) || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (busy || pendingRestore) {
    return reply.code(pendingRestore ? 409 : 503).send({
      code: pendingRestore ? "IOS_RESTORE_PENDING" : "IOS_MAINTENANCE_BUSY",
      error: pendingRestore
        ? "A full restore is ready. Completely close and reopen the app, or cancel the restore before making changes."
        : "A full backup or restore is being prepared. Wait for it to finish before making changes.",
    });
  }
  writes.add(request);
}

export function iosMaintenanceRequestFinished(request: FastifyRequest) {
  writes.delete(request);
}

/** Block new mutations first, then drain the bounded requests already admitted. */
export async function beginIosMaintenance() {
  if (busy || pendingRestore)
    throw Object.assign(new Error("Another backup or restore is pending"), { statusCode: 409 });
  busy = true;
  const deadline = Date.now() + 3000;
  while (writes.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (writes.size > 0) {
    busy = false;
    throw Object.assign(new Error("Wait for the current generation or data operation to finish"), { statusCode: 409 });
  }
  return () => {
    busy = false;
  };
}
