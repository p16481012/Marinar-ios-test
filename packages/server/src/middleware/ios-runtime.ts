import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getIosRuntimeConfig, isIosRuntime } from "../config/ios-runtime.js";

export const IOS_SESSION_COOKIE = "marinara_ios_session";
export const IOS_TOKEN_HEADER = "x-marinara-ios-token";

function validToken(value: unknown): boolean {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(getIosRuntimeConfig().token, "hex"));
}

export function hasIosNativeToken(request: FastifyRequest): boolean {
  return validToken(request.headers[IOS_TOKEN_HEADER]);
}

function hasSessionCookie(request: FastifyRequest): boolean {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${IOS_SESSION_COOKIE}=`));
  return matches.length === 1 && validToken(matches[0]!.slice(IOS_SESSION_COOKIE.length + 1));
}

// These desktop capabilities execute external programs or unreviewed downloaded
// server modules. The prototype keeps their data but refuses execution explicitly.
const UNSUPPORTED_PATHS = [
  "/api/sidecar",
  "/api/utility-sidecar",
  "/api/decision",
  "/api/updates",
  "/api/capability-packages",
  "/api/custom-agent-repositories",
  "/api/personal-extensions",
  "/api/professor-mari/workspace",
  "/api/multiplayer",
  "/api/sprites",
  "/api/admin/restart",
  "/api/import/pick-folder",
  "/api/game-assets/pick-local-music-folder",
  "/api/game-assets/open-folder",
  "/api/fonts/open-folder",
];

export async function iosRuntimeHook(request: FastifyRequest, reply: FastifyReply) {
  if (!isIosRuntime) return;
  const address = request.raw.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
    return reply.code(403).send({ error: "This iOS server accepts device-local requests only" });
  }
  if (!hasIosNativeToken(request) && !hasSessionCookie(request)) {
    return reply.code(401).send({ error: "The iOS app session is required" });
  }
  const origin = request.headers.origin;
  const port = getIosRuntimeConfig().port;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return reply.code(403).send({ error: "This origin cannot access the iOS app" });
  }
  let path: string;
  try {
    path = decodeURIComponent(request.url.split("?", 1)[0] ?? "/");
  } catch {
    return reply.code(400).send({ error: "Invalid request path" });
  }
  if (UNSUPPORTED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return reply.code(501).send({
      code: "IOS_FEATURE_UNAVAILABLE",
      error:
        "This desktop feature is not available in the iOS prototype. Use remote API connections; install app updates through a new IPA.",
    });
  }
}
