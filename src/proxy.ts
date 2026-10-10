import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { decideHostnameGate } from "@/lib/hosted/hostname-gate";

export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    /* ── hostname gate (admin host isolation) ── */
    const requestHostname = (request.headers.get("host") ?? "")
        .split(":")[0]
        .toLowerCase();

    const decision = decideHostnameGate({
        requestHostname,
        pathname,
        adminHostname: env.ADMIN_HOSTNAME,
    });

    switch (decision.kind) {
        case "not-found":
            return new NextResponse(null, { status: 404 });
        case "redirect":
            return NextResponse.redirect(new URL(decision.to, request.url));
        case "next":
            break;
    }

    /* ── Rybbit analytics proxy: strip auth headers ── */
    if (pathname.startsWith("/api/int/")) {
        const headers = new Headers(request.headers);
        headers.delete("cookie");
        headers.delete("authorization");
        return NextResponse.next({ request: { headers } });
    }

    /* ── Admin: expose pathname to server components ── */
    if (pathname.startsWith("/admin")) {
        const headers = new Headers(request.headers);
        headers.set("x-pathname", pathname);
        return NextResponse.next({ request: { headers } });
    }

    return NextResponse.next();
}

export const config = {
    // NOTE: "js" is deliberately NOT in this extension exclusion list.
    // /api/int/script.js and /api/int/replay.js (the Rybbit analytics
    // proxy paths) must still hit this middleware -- excluding .js would
    // skip both the admin-host isolation gate and the auth-header
    // stripping below for those routes.
    //
    // /api/recordings/upload, /api/mcp and /api/internal/mail/* are excluded
    // because Next buffers the whole request body in memory for any route the
    // proxy runs on (and cuts it off past 10 MB): video uploads run to
    // gigabytes, /api/mcp bounds its body only after the caller's token
    // passed, and a raw mail may be 36 MB. Each route applies the admin-host
    // gate itself.
    matcher: [
        "/((?!api/recordings/upload$|api/mcp$|api/internal/mail/precheck$|api/internal/mail/ingest$|_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|woff|woff2|ttf|otf|map)).*)",
    ],
};
