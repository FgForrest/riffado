// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { useGoogleConnectOutcome } from "@/hooks/use-google-connection";

function Probe({ onConnected }: { onConnected?: () => void }) {
    useGoogleConnectOutcome(onConnected);
    return null;
}

describe("Google connect outcome", () => {
    beforeEach(() => {
        toastMock.success.mockReset();
        toastMock.error.mockReset();
    });

    afterEach(() => cleanup());

    it("announces a connection once and drops the parameter", async () => {
        window.history.replaceState(
            null,
            "",
            "/dashboard?folder=f1&google=connected#x",
        );
        const onConnected = vi.fn();
        render(<Probe onConnected={onConnected} />);
        await waitFor(() =>
            expect(toastMock.success).toHaveBeenCalledWith(
                "Google account connected",
            ),
        );
        expect(onConnected).toHaveBeenCalledTimes(1);
        expect(`${window.location.search}${window.location.hash}`).toBe(
            "?folder=f1#x",
        );
    });

    it("explains a refusal", async () => {
        window.history.replaceState(
            null,
            "",
            "/dashboard?google=missing_scope",
        );
        render(<Probe />);
        await waitFor(() =>
            expect(toastMock.error).toHaveBeenCalledWith(
                "Google Drive access was not granted. Connect again and allow it.",
            ),
        );
        expect(window.location.search).toBe("");
    });

    it("stays quiet without the parameter", async () => {
        window.history.replaceState(null, "", "/dashboard");
        render(<Probe />);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(toastMock.success).not.toHaveBeenCalled();
        expect(toastMock.error).not.toHaveBeenCalled();
    });
});
