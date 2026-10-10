/**
 * The mail receiver container's entry point (`mail-receiver/Dockerfile`
 * bundles this file for Node). Reads its configuration from the
 * environment, refreshes the allowed sources every six hours, listens.
 */

import { readFileSync } from "node:fs";
import { createReceiver } from "@/lib/mail/receiver/receiver";
import { AllowedSources } from "@/lib/mail/receiver/sources";

const REFRESH_MS = 6 * 60 * 60 * 1000;

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        console.error(`[mail-receiver] ${name} is required`);
        process.exit(1);
    }
    return value;
}

function optionalFile(name: string): Buffer | undefined {
    const path = process.env[name]?.trim();
    return path ? readFileSync(path) : undefined;
}

async function main(): Promise<void> {
    const sources = new AllowedSources(
        process.env.MAIL_ALLOWED_SOURCES?.trim() || "google",
    );
    const refresh = async () => {
        try {
            await sources.refresh();
        } catch (error) {
            console.error(
                "[mail-receiver] could not refresh the allowed sources:",
                error instanceof Error ? error.message : error,
            );
        }
    };
    await refresh();
    setInterval(refresh, REFRESH_MS).unref();

    const tlsKey = optionalFile("MAIL_TLS_KEY_FILE");
    const tlsCert = optionalFile("MAIL_TLS_CERT_FILE");
    if (!tlsKey || !tlsCert) {
        console.warn(
            "[mail-receiver] no MAIL_TLS_KEY_FILE/MAIL_TLS_CERT_FILE: STARTTLS is off",
        );
    }
    const server = createReceiver({
        domain: required("MAIL_DOMAIN").toLowerCase(),
        hostname: required("MAIL_HOSTNAME"),
        ingestUrl: required("MAIL_INGEST_URL"),
        ingestSecret: required("MAIL_INGEST_SECRET"),
        maxMessageBytes:
            Number(process.env.MAIL_MAX_MESSAGE_MB || "36") * 1024 * 1024,
        sources,
        tlsKey,
        tlsCert,
        spoolDir: process.env.MAIL_SPOOL_DIR?.trim() || "/spool",
        maxConnectionsPerIp: Number(
            process.env.MAIL_MAX_CONNECTIONS_PER_IP || "10",
        ),
        maxConcurrentIngests: Number(
            process.env.MAIL_MAX_CONCURRENT_INGESTS || "4",
        ),
    });
    const port = Number(process.env.MAIL_PORT || "2525");
    server.listen(port, () => {
        console.log(`[mail-receiver] listening on ${port}`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}

void main();
