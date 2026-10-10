import { NextResponse } from "next/server";
import { withAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { createConnection, deleteConnection, listConnections, trustHostKey, updateConnection, type ConnectionInput } from "@/lib/connections";
import { cancelConnectionUploads } from "@/lib/remote-pieces";
import { assertMutationRequest, AppError, jsonError, readJsonBody } from "@/lib/http";
import { closeSession, testConnection } from "@/lib/sftp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The owner's other servers (never their credentials). */
export async function GET(request: Request) {
  try {
    return await withAccess(request, "owner", async () => NextResponse.json({ connections: await listConnections() }, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    return jsonError(error);
  }
}

type Body = ConnectionInput & { action?: unknown; id?: unknown; fingerprint?: unknown };

export async function POST(request: Request) {
  try {
    assertMutationRequest(request);
    return await withAccess(request, "owner", async (session) => {
      const body = await readJsonBody<Body>(request, 64 * 1024);
      const id = typeof body.id === "string" && body.id.length <= 64 ? body.id : "";
      switch (body.action) {
        case "create": {
          const connection = await createConnection(body);
          await audit("connections.create", { username: session.username, name: connection.name, host: connection.host, port: connection.port, account: connection.username });
          return NextResponse.json({ connection });
        }
        case "update": {
          // Uploads in progress to the server end first, so their temporary files are removed with the old settings.
          await cancelConnectionUploads(id);
          const connection = await updateConnection(id, body);
          await closeSession(id);
          await audit("connections.update", { username: session.username, name: connection.name, host: connection.host, port: connection.port, account: connection.username });
          return NextResponse.json({ connection });
        }
        case "delete": {
          await cancelConnectionUploads(id);
          const connection = await deleteConnection(id);
          await closeSession(id);
          await audit("connections.delete", { username: session.username, name: connection.name, host: connection.host });
          return NextResponse.json({ ok: true });
        }
        case "trust": {
          const connection = await trustHostKey(id, body.fingerprint as string);
          await closeSession(id);
          await audit("connections.trust", { username: session.username, name: connection.name, host: connection.host, fingerprint: connection.hostKey });
          return NextResponse.json({ connection });
        }
        case "test":
          try {
            return NextResponse.json(await testConnection(id));
          } catch (error) {
            // An unconfirmed or changed host key comes back with the fingerprint to confirm.
            const fingerprint = (error as { fingerprint?: string }).fingerprint;
            if (error instanceof AppError && fingerprint) return NextResponse.json({ error: error.message, code: error.code, fingerprint }, { status: error.status });
            throw error;
          }
        default:
          throw new AppError("Unknown action", 400, "UNKNOWN_ACTION");
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
