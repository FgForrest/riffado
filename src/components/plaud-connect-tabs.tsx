"use client";

import { Check, Copy } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api-errors";
import {
    DEFAULT_SERVER_KEY,
    PLAUD_SERVERS,
    type PlaudServerKey,
} from "@/lib/plaud/servers";

const CONNECTOR_CHROME_URL =
    "https://github.com/riffado/connector#installation";

// API contract for the Riffado Connector extension; bump `version` on both sides.
interface ConnectorBridge {
    version: number;
    connect(): Promise<{
        accessToken: string;
        apiBase: string;
        region: "global" | "euc1" | "apse1" | "unknown";
        capturedAt: number;
    }>;
}

declare global {
    interface Window {
        __riffadoConnector?: ConnectorBridge;
    }
}

type Mode = "connector" | "email" | "token";
type EmailStep = "email" | "code";

const RESEND_COOLDOWN_MS = 30_000;
const ISSUE_URL = "https://github.com/riffado/riffado/issues/65";

// One-liner the user pastes into the web.plaud.ai console. Reads
// `pld_tokenstr` (the long-lived ~300-day user token, stored as a
// JSON-encoded `"bearer eyJ…"` string) and copies the bare JWT to the
// clipboard. This is the same localStorage key the connector reads, so it
// deterministically yields the account token — never the short-lived 24h
// workspace token that rides on /device/list. (issue #203)
const TOKEN_GRAB_SNIPPET =
    'copy(JSON.parse(localStorage.pld_tokenstr).replace(/^bearer /i,""))';

interface PlaudConnectTabsProps {
    onConnected: () => void;
}

export function PlaudConnectTabs({ onConnected }: PlaudConnectTabsProps) {
    const i18n = useExtracted();
    const [hasConnector, setHasConnector] = useState<boolean>(false);
    useEffect(() => {
        let cancelled = false;
        const check = () => {
            if (cancelled) return;
            const v = window.__riffadoConnector?.version;
            if (typeof v === "number" && v >= 1) setHasConnector(true);
        };
        check();
        const id = window.setInterval(check, 750);
        const stop = window.setTimeout(() => window.clearInterval(id), 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
            window.clearTimeout(stop);
        };
    }, []);

    const [mode, setMode] = useState<Mode>("connector");

    const tabs: { key: Mode; label: string }[] = [
        { key: "connector", label: i18n("Sign in with Plaud") },
        { key: "email", label: i18n("Email code") },
        { key: "token", label: i18n("Paste token") },
    ];

    return (
        <div className="space-y-4">
            <div
                role="tablist"
                aria-label={i18n("Plaud connection method")}
                className="grid grid-cols-3 gap-1 p-1 rounded-md bg-muted/50 border"
            >
                {tabs.map((t) => (
                    <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={mode === t.key}
                        onClick={() => setMode(t.key)}
                        className={`px-3 py-1.5 text-sm rounded transition-colors ${
                            mode === t.key
                                ? "bg-background shadow-sm font-medium"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {mode === "connector" && (
                <ConnectorPane
                    onConnected={onConnected}
                    hasConnector={hasConnector}
                    onUseEmail={() => setMode("email")}
                    onUseToken={() => setMode("token")}
                />
            )}
            {mode === "email" && (
                <EmailCodePane
                    onConnected={onConnected}
                    onSwitchToToken={() => setMode("token")}
                />
            )}
            {mode === "token" && (
                <PasteTokenPane
                    onConnected={onConnected}
                    onUseConnector={() => setMode("connector")}
                />
            )}
        </div>
    );
}

interface ConnectorPaneProps {
    onConnected: () => void;
    hasConnector: boolean;
    onUseEmail: () => void;
    onUseToken: () => void;
}

function ConnectorPane({
    onConnected,
    hasConnector,
    onUseEmail,
    onUseToken,
}: ConnectorPaneProps) {
    const i18n = useExtracted();
    const [isLoading, setIsLoading] = useState(false);

    const handleConnect = useCallback(async () => {
        const bridge = window.__riffadoConnector;
        if (!bridge) {
            toast.error(i18n("Connector extension not detected"));
            return;
        }
        setIsLoading(true);
        try {
            const payload = await bridge.connect();
            const res = await fetch("/api/plaud/auth/connect-token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accessToken: payload.accessToken,
                    apiBase: payload.apiBase,
                    source: "connector",
                }),
            });
            if (!res.ok) {
                await toastApiError(res, {
                    fallback: "Failed to connect Plaud",
                    errorContext: "connect Plaud via connector extension",
                });
                return;
            }
            toast.success(i18n("Plaud account connected"));
            onConnected();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : i18n("Failed to connect"),
            );
        } finally {
            setIsLoading(false);
        }
    }, [onConnected, i18n]);

    if (!hasConnector) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                    {i18n("Easiest path: install the")}{" "}
                    <span className="font-medium">
                        {i18n("Riffado Connector")}
                    </span>{" "}
                    {i18n(
                        "browser extension. Sign in to Plaud the way you normally do (Google, Apple, or email) and the connector hands the session back here, no copy-pasting.",
                    )}
                </p>
                <Button asChild className="w-full">
                    <a
                        href={CONNECTOR_CHROME_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {i18n("Install Riffado Connector")}
                    </a>
                </Button>
                <p className="text-xs text-muted-foreground/80 leading-relaxed">
                    {i18n(
                        "Already installed? Reload this page so Riffado can detect it. Or use the",
                    )}{" "}
                    <button
                        type="button"
                        onClick={onUseEmail}
                        className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground"
                    >
                        {i18n("email code")}
                    </button>{" "}
                    /{" "}
                    <button
                        type="button"
                        onClick={onUseToken}
                        className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground"
                    >
                        {i18n("paste token")}
                    </button>{" "}
                    {i18n("methods instead.")}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
                {i18n(
                    "Click below to sign in to Plaud in a new tab. Use Google, Apple, or email/password as you normally would. The connector will return you here automatically.",
                )}
            </p>
            <Button
                onClick={handleConnect}
                disabled={isLoading}
                className="w-full"
            >
                {isLoading
                    ? i18n("Waiting for plaud.ai sign-in…")
                    : i18n("Continue with Plaud")}
            </Button>
            <p className="text-xs text-muted-foreground/80 leading-relaxed">
                {i18n("Stuck?")}{" "}
                <button
                    type="button"
                    onClick={onUseEmail}
                    className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground"
                >
                    {i18n("Use email code")}
                </button>{" "}
                {i18n("or")}{" "}
                <button
                    type="button"
                    onClick={onUseToken}
                    className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground"
                >
                    {i18n("paste token")}
                </button>
                .
            </p>
        </div>
    );
}

// \u2500\u2500 Email code (OTP) pane \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface EmailCodePaneProps {
    onConnected: () => void;
    onSwitchToToken: () => void;
}

function EmailCodePane({ onConnected, onSwitchToToken }: EmailCodePaneProps) {
    const i18n = useExtracted();
    const [step, setStep] = useState<EmailStep>("email");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [otpToken, setOtpToken] = useState("");
    const [apiBase, setApiBase] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [lastSentAt, setLastSentAt] = useState(0);

    const handleSendCode = useCallback(async () => {
        const trimmed = email.trim();
        if (!trimmed) {
            toast.error(i18n("Please enter your Plaud email"));
            return;
        }
        const now = Date.now();
        if (now - lastSentAt < RESEND_COOLDOWN_MS) {
            const secs = Math.ceil(
                (RESEND_COOLDOWN_MS - (now - lastSentAt)) / 1000,
            );
            toast.error(
                i18n(
                    "Please wait {seconds, plural, one {# second} other {# seconds}} before resending",
                    { seconds: secs },
                ),
            );
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch("/api/plaud/auth/send-code", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: trimmed }),
            });
            if (!res.ok) {
                await toastApiError(res, {
                    fallback: "Failed to send code",
                    errorContext: "send Plaud verification code",
                });
                return;
            }
            const data = await res.json();
            setOtpToken(data.otpToken);
            setApiBase(data.apiBase);
            setLastSentAt(Date.now());
            setStep("code");
            toast.success(i18n("Verification code sent. Check your email."));
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : i18n("Failed to send code"),
            );
        } finally {
            setIsLoading(false);
        }
    }, [email, lastSentAt, i18n]);

    const handleVerify = useCallback(async () => {
        const trimmed = code.trim();
        if (!trimmed) {
            toast.error(i18n("Please enter the verification code"));
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch("/api/plaud/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code: trimmed,
                    otpToken,
                    apiBase,
                    email,
                }),
            });
            if (!res.ok) {
                await toastApiError(res, {
                    fallback: "Verification failed",
                    errorContext: "verify Plaud OTP code",
                });
                return;
            }
            toast.success(i18n("Plaud account connected"));
            onConnected();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : i18n("Verification failed"),
            );
        } finally {
            setIsLoading(false);
        }
    }, [code, otpToken, apiBase, email, onConnected, i18n]);

    if (step === "email") {
        return (
            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="plaud-email">{i18n("Plaud Email")}</Label>
                    <Input
                        id="plaud-email"
                        type="email"
                        placeholder={i18n("you@example.com")}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
                        disabled={isLoading}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional -- modal-entry input, focusing it is the whole UX point
                        autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "The email you use to sign in at plaud.ai. We'll send a verification code via Plaud's servers.",
                        )}
                    </p>
                </div>

                <Button
                    onClick={handleSendCode}
                    disabled={isLoading || !email.trim()}
                    className="w-full"
                >
                    {isLoading
                        ? i18n("Sending code via plaud.ai…")
                        : i18n("Send Verification Code")}
                </Button>

                <p className="text-xs text-muted-foreground/80 leading-relaxed">
                    {i18n("Signed up to Plaud with")}{" "}
                    <span className="font-medium">
                        {i18n("Google or Apple")}
                    </span>
                    {i18n(
                        "? The email-code flow may sign you into a different (empty) Plaud account.",
                    )}{" "}
                    <button
                        type="button"
                        onClick={onSwitchToToken}
                        className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground transition-colors"
                    >
                        {i18n("Use the paste-token method instead.")}
                    </button>{" "}
                    <a
                        href={ISSUE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground transition-colors"
                    >
                        {i18n("#65&nbsp;→")}
                    </a>
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor="otp-code">{i18n("Verification Code")}</Label>
                <Input
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    placeholder={i18n("000000")}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                    disabled={isLoading}
                    className="font-mono text-lg tracking-[0.3em] text-center"
                    // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional -- OTP code input shown right after "we sent you a code"; user is expected to type immediately
                    autoFocus
                    autoComplete="one-time-code"
                />
                <p className="text-xs text-muted-foreground">
                    {i18n("Code sent to")}{" "}
                    <span className="font-mono">{email}</span>
                    {apiBase && (
                        <span>
                            {i18n("· Region:")}{" "}
                            {apiBase.includes("euc1")
                                ? i18n("EU (Frankfurt)")
                                : apiBase.includes("apse1")
                                  ? i18n("Asia Pacific (Singapore)")
                                  : apiBase.includes("api.plaud.ai")
                                    ? i18n("Global")
                                    : apiBase}
                        </span>
                    )}
                </p>
            </div>

            <Button
                onClick={handleVerify}
                disabled={isLoading || !code.trim()}
                className="w-full"
            >
                {isLoading
                    ? i18n("Verifying with plaud.ai…")
                    : i18n("Connect Account")}
            </Button>

            <div className="flex items-center justify-between text-xs text-muted-foreground/70">
                <button
                    type="button"
                    onClick={() => {
                        setStep("email");
                        setCode("");
                    }}
                    className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground transition-colors"
                >
                    {i18n("← Different email")}
                </button>
                <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={isLoading}
                    className="underline decoration-dotted underline-offset-2 hover:text-muted-foreground transition-colors disabled:opacity-50"
                >
                    {i18n("Resend code")}
                </button>
            </div>
        </div>
    );
}

// \u2500\u2500 Paste token pane \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Console-styled copy block for the token-grab snippet. Distinct from
// `CopyableCommand` (which renders shell chrome) so the user reads it as
// "paste into your browser console," not "run in a terminal."
function ConsoleSnippet({
    snippet,
    ariaLabel,
}: {
    snippet: string;
    ariaLabel?: string;
}) {
    const i18n = useExtracted();
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (timerRef.current !== null) clearTimeout(timerRef.current);
        },
        [],
    );
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                setCopied(false);
                timerRef.current = null;
            }, 1600);
        } catch {
            // Clipboard can reject in insecure contexts; text stays selectable.
        }
    }, [snippet]);
    return (
        <div className="rounded-md border border-input bg-muted/40 overflow-hidden">
            <div className="flex items-center px-3 py-1.5 border-b border-input/60 bg-muted">
                <span className="text-[11px] font-mono text-muted-foreground">
                    {i18n("web.plaud.ai console")}
                </span>
            </div>
            <div className="flex items-center gap-2 p-2.5 font-mono text-xs">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-foreground">
                    {snippet}
                </code>
                <button
                    type="button"
                    onClick={handleCopy}
                    aria-label={ariaLabel ?? i18n("Copy snippet")}
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                    {copied ? (
                        <>
                            <Check className="size-3 text-green-600" />
                            <span>{i18n("Copied")}</span>
                        </>
                    ) : (
                        <>
                            <Copy className="size-3" />
                            <span>{i18n("Copy")}</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}

interface PasteTokenPaneProps {
    onConnected: () => void;
    onUseConnector: () => void;
}

function PasteTokenPane({ onConnected, onUseConnector }: PasteTokenPaneProps) {
    const i18n = useExtracted();
    const [token, setToken] = useState("");
    const [serverKey, setServerKey] =
        useState<PlaudServerKey>(DEFAULT_SERVER_KEY);
    const [customApiBase, setCustomApiBase] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    const apiBase =
        serverKey === "custom"
            ? customApiBase.trim()
            : PLAUD_SERVERS[serverKey].apiBase;

    const handleSubmit = useCallback(async () => {
        const trimmed = token.trim().replace(/^Bearer\s+/i, "");
        if (!trimmed) {
            toast.error(i18n("Paste your Plaud access token first"));
            return;
        }
        if (serverKey === "custom" && !apiBase) {
            toast.error(i18n("Enter your custom Plaud API URL"));
            return;
        }
        setIsLoading(true);
        try {
            const res = await fetch("/api/plaud/auth/connect-token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    accessToken: trimmed,
                    apiBase,
                    source: "paste",
                }),
            });
            if (!res.ok) {
                await toastApiError(res, {
                    fallback: "Failed to connect Plaud",
                    errorContext: "connect Plaud via pasted access token",
                });
                return;
            }
            toast.success(i18n("Plaud account connected"));
            onConnected();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : i18n("Failed to connect Plaud"),
            );
        } finally {
            setIsLoading(false);
        }
    }, [token, apiBase, serverKey, onConnected, i18n]);

    return (
        <div className="space-y-4">
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 space-y-1">
                <p className="text-xs font-medium text-foreground">
                    {i18n("Recommended: use the connector instead")}
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    {i18n(
                        "The Riffado Connector signs you in and captures the right long-lived token automatically — no copying, and it won't stop working after a day.",
                    )}{" "}
                    <button
                        type="button"
                        onClick={onUseConnector}
                        className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                    >
                        {i18n("Use the connector&nbsp;→")}
                    </button>
                </p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
                {i18n(
                    "Prefer to paste manually? Grab your account token from a logged-in web.plaud.ai session.",
                )}{" "}
                <a
                    href={ISSUE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                >
                    {i18n("Why? · #65&nbsp;→")}
                </a>
            </p>

            <div className="space-y-2">
                <Label htmlFor="plaud-region">{i18n("Plaud region")}</Label>
                <select
                    id="plaud-region"
                    value={serverKey}
                    onChange={(e) =>
                        setServerKey(e.target.value as PlaudServerKey)
                    }
                    disabled={isLoading}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                    {(Object.keys(PLAUD_SERVERS) as PlaudServerKey[]).map(
                        (key) => (
                            <option key={key} value={key}>
                                {PLAUD_SERVERS[key].label}
                            </option>
                        ),
                    )}
                </select>
                {serverKey === "custom" && (
                    <Input
                        type="url"
                        placeholder={i18n("https://api-xxx.plaud.ai")}
                        value={customApiBase}
                        onChange={(e) => setCustomApiBase(e.target.value)}
                        disabled={isLoading}
                        className="font-mono text-xs"
                    />
                )}
                <p className="text-xs text-muted-foreground">
                    {i18n("Look at the host of any")}{" "}
                    <span className="font-mono">{i18n("api*.plaud.ai")}</span>{" "}
                    {i18n(
                        "request in your devtools Network tab to find the region.",
                    )}
                </p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="plaud-access-token">
                    {i18n("Access token")}
                </Label>
                <textarea
                    id="plaud-access-token"
                    placeholder={i18n("eyJhbGciOi…")}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={isLoading}
                    rows={4}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono break-all resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                />
            </div>

            <Button
                onClick={handleSubmit}
                disabled={isLoading || !token.trim()}
                className="w-full"
            >
                {isLoading
                    ? i18n("Validating with plaud.ai…")
                    : i18n("Connect with token")}
            </Button>

            <details className="group">
                <summary className="text-xs text-muted-foreground/80 cursor-pointer hover:text-muted-foreground transition-colors select-none">
                    {i18n("How do I get my token?")}
                </summary>
                <div className="mt-3 space-y-4 text-xs text-muted-foreground leading-relaxed">
                    <div className="space-y-1">
                        <p className="font-medium text-foreground">
                            {i18n("Easiest — the connector")}
                        </p>
                        <p>
                            {i18n("Skip the copying entirely.")}{" "}
                            <button
                                type="button"
                                onClick={onUseConnector}
                                className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                            >
                                {i18n("Use the Riffado Connector")}
                            </button>{" "}
                            {i18n("and it captures the right token for you.")}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <p className="font-medium text-foreground">
                            {i18n("Fast — paste a one-line snippet")}
                        </p>
                        <ol className="ml-4 list-decimal space-y-1">
                            <li>
                                {i18n("Open")}{" "}
                                <a
                                    href="https://web.plaud.ai"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline decoration-dotted underline-offset-2"
                                >
                                    {i18n("web.plaud.ai")}
                                </a>{" "}
                                {i18n("and sign in (Google, Apple, or email).")}
                            </li>
                            <li>
                                {i18n("Open the browser console (F12 →")}{" "}
                                <span className="font-medium">
                                    {i18n("Console")}
                                </span>
                                ).
                            </li>
                            <li>
                                {i18n(
                                    "Paste this and press Enter — it copies your token to the clipboard:",
                                )}
                            </li>
                        </ol>
                        <ConsoleSnippet
                            snippet={TOKEN_GRAB_SNIPPET}
                            ariaLabel={i18n("Copy the token-grab snippet")}
                        />
                        <p>
                            {i18n(
                                "Then paste it into the box above. If the console shows a “don't paste here” warning, use the manual steps below.",
                            )}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <p className="font-medium text-foreground">
                            {i18n("Manual — from storage")}
                        </p>
                        <ol className="ml-4 list-decimal space-y-1">
                            <li>
                                {i18n("On web.plaud.ai, open devtools (F12) →")}{" "}
                                <span className="font-medium">
                                    {i18n("Application")}
                                </span>{" "}
                                →{" "}
                                <span className="font-medium">
                                    {i18n("Local Storage")}
                                </span>{" "}
                                →{" "}
                                <span className="font-mono">
                                    {i18n("https://web.plaud.ai")}
                                </span>
                                .
                            </li>
                            <li>
                                {i18n("Find")}{" "}
                                <span className="font-mono">
                                    {i18n("pld_tokenstr")}
                                </span>
                                {i18n(
                                    ". Copy its value, then strip the wrapping quotes and the leading",
                                )}{" "}
                                <span className="font-mono">
                                    {i18n("bearer&nbsp;")}
                                </span>
                                .
                            </li>
                            <li>
                                {i18n("Paste the remaining")}{" "}
                                <span className="font-mono">
                                    {i18n("eyJ…")}
                                </span>{" "}
                                {i18n(
                                    "token above, and pick the region matching the",
                                )}{" "}
                                <span className="font-mono">
                                    {i18n("api*.plaud.ai")}
                                </span>{" "}
                                {i18n("host you see in the Network tab.")}
                            </li>
                        </ol>
                    </div>

                    <p className="text-muted-foreground/80">
                        {i18n("Don't copy the Authorization header from a")}{" "}
                        <span className="font-mono">
                            {i18n("/device/list")}
                        </span>{" "}
                        {i18n("or")}{" "}
                        <span className="font-mono">
                            {i18n("/file/simple/web")}
                        </span>{" "}
                        {i18n(
                            "request — that's a short-lived 24-hour token that stops working within a day. Your account token lives ~300 days and is encrypted (AES-256-GCM) before storage on this instance.",
                        )}
                    </p>
                </div>
            </details>
        </div>
    );
}
