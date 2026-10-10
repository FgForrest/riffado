/**
 * Klepna's mail receiver: an SMTP server for one domain that never relays,
 * never authenticates clients and never sends mail. It verifies DKIM,
 * asks the app which recipients would pass (precheck, metadata only), and
 * hands the raw message to the app only then (ingest). It holds no
 * database credentials and no encryption key: the ingest secret and its
 * TLS key are all it has.
 *
 * Answers: other domains 550 at RCPT; after DATA 250 for every recipient
 * of the domain whatever the app decided (D7), 452 when an owner is over
 * their daily limit, 451 when the app cannot be reached or fails, 552
 * past the size limit. Logs carry verdicts, codes and sizes, never
 * addresses or subjects.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DNSResolver } from "mailauth";
import {
    SMTPServer,
    type SMTPServerDataStream,
    type SMTPServerOptions,
    type SMTPServerSession,
} from "smtp-server";
import { authenticateMessage } from "@/lib/mail/dkim";
import type { AllowedSources } from "@/lib/mail/receiver/sources";

export interface ReceiverConfig {
    /** The one domain mail is accepted for, lowercase. */
    domain: string;
    /** The name the server greets with. */
    hostname: string;
    /** The app, e.g. `http://app:3000`. */
    ingestUrl: string;
    ingestSecret: string;
    maxMessageBytes: number;
    sources: AllowedSources;
    /** PEM. Without them no STARTTLS is offered (tests only). */
    tlsKey?: Buffer;
    tlsCert?: Buffer;
    spoolDir: string;
    maxRecipients?: number;
    maxConnectionsPerIp?: number;
    maxConcurrentIngests?: number;
    /** Milliseconds a call to the app may take. */
    appTimeoutMs?: number;
    resolver?: DNSResolver;
    log?: (entry: Record<string, unknown>) => void;
}

/** An SMTP error with its reply code. */
function smtpError(code: number, message: string): Error {
    const error = new Error(message) as Error & { responseCode: number };
    error.responseCode = code;
    return error;
}

class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}

/** A short, non-reversible tag of a message for the logs. */
function messageTag(raw: Buffer): string {
    return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Creates (not yet listening) the receiver's SMTP server. */
export function createReceiver(config: ReceiverConfig): SMTPServer {
    const maxRecipients = config.maxRecipients ?? 100;
    const perIp = config.maxConnectionsPerIp ?? 10;
    const ingests = new Semaphore(config.maxConcurrentIngests ?? 4);
    const appTimeoutMs = config.appTimeoutMs ?? 60_000;
    const connections = new Map<string, number>();
    const log = config.log ?? ((entry) => console.log(JSON.stringify(entry)));

    const callApp = async (
        path: string,
        init: { body: BodyInit; headers: Record<string, string> },
    ): Promise<Response> =>
        fetch(new URL(path, config.ingestUrl), {
            method: "POST",
            body: init.body,
            headers: {
                authorization: `Bearer ${config.ingestSecret}`,
                ...init.headers,
            },
            signal: AbortSignal.timeout(appTimeoutMs),
        });

    const deliver = async (
        raw: Buffer,
        session: SMTPServerSession,
    ): Promise<{ code: number; verdict: string }> => {
        const recipients = session.envelope.rcptTo.map((rcpt) =>
            rcpt.address.toLowerCase(),
        );
        const facts = await authenticateMessage(raw, {
            resolver: config.resolver,
            now: new Date(),
        });
        const precheck = await callApp("/api/internal/mail/precheck", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                recipients,
                facts: {
                    fromHeaders: facts.fromHeaders,
                    fromAddresses: facts.fromAddresses,
                    dkim: facts.dkim.map((signature) => ({
                        ...signature,
                        signedAt: signature.signedAt?.toISOString() ?? null,
                    })),
                },
            }),
        });
        if (!precheck.ok)
            throw new Error(`precheck answered ${precheck.status}`);
        const { accepted } = (await precheck.json()) as { accepted: string[] };
        if (accepted.length === 0) return { code: 250, verdict: "refused" };
        const ingest = await callApp("/api/internal/mail/ingest", {
            // fetch sends the body's length itself; undici on Node 22
            // refuses one set by hand.
            headers: {
                "content-type": "message/rfc822",
                "x-mail-sha256": createHash("sha256").update(raw).digest("hex"),
                "x-mail-recipients": Buffer.from(
                    JSON.stringify(recipients),
                ).toString("base64"),
            },
            body: new Uint8Array(raw),
        });
        if (!ingest.ok) throw new Error(`ingest answered ${ingest.status}`);
        const result = (await ingest.json()) as { overQuota?: boolean };
        return result.overQuota
            ? { code: 452, verdict: "over_quota" }
            : { code: 250, verdict: "delivered" };
    };

    const options: SMTPServerOptions = {
        name: config.hostname,
        banner: "Klepna mail receiver",
        secure: false,
        key: config.tlsKey,
        cert: config.tlsCert,
        hideSTARTTLS: !config.tlsKey || !config.tlsCert,
        authOptional: true,
        disabledCommands: ["AUTH"],
        size: config.maxMessageBytes,
        maxClients: 200,
        socketTimeout: 60_000,
        closeTimeout: 30_000,
        logger: false,
        onConnect(session, callback) {
            const address = session.remoteAddress;
            if (!config.sources.allows(address)) {
                log({ event: "connect", verdict: "source_refused" });
                return callback(smtpError(554, "5.7.1 Not accepted from here"));
            }
            const open = connections.get(address) ?? 0;
            if (open >= perIp) {
                return callback(smtpError(421, "4.7.0 Too many connections"));
            }
            connections.set(address, open + 1);
            return callback();
        },
        onClose(session) {
            const address = session.remoteAddress;
            const open = (connections.get(address) ?? 1) - 1;
            if (open <= 0) connections.delete(address);
            else connections.set(address, open);
        },
        onMailFrom(_address, _session, callback) {
            callback();
        },
        onRcptTo(address, session, callback) {
            const recipient = address.address.toLowerCase();
            const at = recipient.lastIndexOf("@");
            if (at <= 0 || recipient.slice(at + 1) !== config.domain) {
                return callback(smtpError(550, "5.7.1 Relaying denied"));
            }
            if (session.envelope.rcptTo.length >= maxRecipients) {
                return callback(smtpError(452, "4.5.3 Too many recipients"));
            }
            return callback();
        },
        onData(stream: SMTPServerDataStream, session, callback) {
            void (async () => {
                const dir = await mkdtemp(join(config.spoolDir, "msg-"));
                const file = join(dir, "message.eml");
                try {
                    let size = 0;
                    let tooBig = false;
                    // Past the limit the rest is read and dropped: the
                    // client still waits for its answer.
                    await pipeline(
                        stream,
                        async function* (source: AsyncIterable<Buffer>) {
                            for await (const chunk of source) {
                                size += chunk.length;
                                if (size > config.maxMessageBytes) {
                                    tooBig = true;
                                    continue;
                                }
                                yield chunk;
                            }
                        },
                        createWriteStream(file),
                    );
                    if (tooBig || stream.sizeExceeded) {
                        log({
                            event: "data",
                            verdict: "too_big",
                            code: 552,
                            size,
                        });
                        return callback(
                            smtpError(552, "5.3.4 Message too big"),
                        );
                    }
                    const raw = await readFile(file);
                    const outcome = await ingests.run(() =>
                        deliver(raw, session),
                    );
                    log({
                        event: "data",
                        verdict: outcome.verdict,
                        code: outcome.code,
                        size: raw.length,
                        recipients: session.envelope.rcptTo.length,
                        tag: messageTag(raw),
                    });
                    if (outcome.code === 452) {
                        return callback(
                            smtpError(
                                452,
                                "4.2.2 Mailbox over quota, try later",
                            ),
                        );
                    }
                    return callback();
                } catch (error) {
                    log({
                        event: "data",
                        verdict: "app_error",
                        code: 451,
                        error: error instanceof Error ? error.message : "error",
                    });
                    return callback(smtpError(451, "4.3.0 Try again later"));
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            })();
        },
    };
    return new SMTPServer(options);
}
