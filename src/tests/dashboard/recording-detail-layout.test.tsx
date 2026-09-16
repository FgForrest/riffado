// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "@/types/recording";

vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => <div data-testid="recording-player" />,
}));

vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingPlayerHeader: ({ recording }: { recording: Recording }) => (
        <h1>{recording.filename}</h1>
    ),
}));

vi.mock("@/components/dashboard/transcription-panel", () => ({
    TranscriptionPanel: () => <div data-testid="transcription-panel" />,
}));

vi.mock("@/components/recordings/erase-recording-menu", () => ({
    EraseRecordingMenu: () => null,
}));

import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";

const recording: Recording = {
    id: "rec-1",
    filename: "Planning session",
    duration: 60_000,
    filesize: 1024,
    startTime: new Date(0).toISOString(),
    deviceSn: "local",
};

const sharedProps = {
    currentTranscription: undefined,
    transcripts: undefined,
    isCurrentTranscribing: false,
    visibleRecordings: [recording],
    onTranscribe: vi.fn(),
    onSelectRecording: vi.fn(),
    onDelete: vi.fn(),
    onArtifactsChanged: vi.fn(),
    onBackToList: vi.fn(),
    hiddenOnMobile: false,
    initialPlaybackSpeed: 1,
    initialVolume: 75,
    initialAutoPlayNext: false,
    scrubberStyle: "waveform" as const,
};

describe("recording detail layout", () => {
    afterEach(cleanup);

    it("keeps the recording heading while removing the player for erased audio", () => {
        const { rerender } = render(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={recording}
            />,
        );

        expect(
            screen.getByRole("heading", { name: "Planning session" }),
        ).toBeTruthy();
        expect(screen.getByTestId("recording-player")).toBeTruthy();

        rerender(
            <WorkstationDetailPane
                {...sharedProps}
                currentRecording={{ ...recording, audioReaped: true }}
            />,
        );

        expect(
            screen.getByRole("heading", { name: "Planning session" }),
        ).toBeTruthy();
        expect(screen.queryByTestId("recording-player")).toBeNull();
        expect(screen.getByTestId("transcription-panel")).toBeTruthy();
    });
});
