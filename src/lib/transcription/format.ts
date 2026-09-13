import type {
    TranscriptionCreateParamsNonStreaming,
    TranscriptionDiarized,
    TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";
import {
    type TranscriptTurn,
    turnsFromLabelledSegments,
} from "@/lib/transcription/turns";

export type ResponseFormat = "diarized_json" | "json" | "verbose_json";

export function getResponseFormat(model: string): ResponseFormat {
    if (model.includes("diarize")) return "diarized_json";
    if (model.startsWith("gpt-4o")) return "json";
    return "verbose_json";
}

export interface ParsedTranscription {
    text: string;
    detectedLanguage: string | null;
    /** Present only for a diarized response that carried segments. */
    turns?: TranscriptTurn[];
}

export function parseTranscriptionResponse(
    transcription: unknown,
    responseFormat: ResponseFormat,
): ParsedTranscription {
    if (responseFormat === "diarized_json") {
        const diarized = transcription as TranscriptionDiarized;
        const segments = diarized.segments ?? [];
        const text = segments
            .map((seg) => `${seg.speaker}: ${seg.text}`)
            .join("\n");
        const turns = turnsFromLabelledSegments(
            segments.map((seg) => ({
                speaker: seg.speaker,
                startMs: Math.round(seg.start * 1000),
                endMs: Math.round(seg.end * 1000),
                text: seg.text,
            })),
        );
        return {
            text,
            detectedLanguage: null,
            ...(turns ? { turns } : {}),
        };
    }

    if (responseFormat === "verbose_json") {
        const verbose = transcription as TranscriptionVerbose;
        return {
            text: verbose.text,
            detectedLanguage: verbose.language ?? null,
        };
    }

    const plain = transcription as { text?: string };
    const text =
        typeof transcription === "string" ? transcription : (plain.text ?? "");
    return { text, detectedLanguage: null };
}

export function buildTranscriptionParams(args: {
    file: File;
    model: string;
    responseFormat: ResponseFormat;
    language?: string;
}): TranscriptionCreateParamsNonStreaming {
    const { file, model, responseFormat, language } = args;
    return {
        file,
        model,
        response_format: responseFormat,
        ...(responseFormat === "diarized_json"
            ? { chunking_strategy: "auto" as const }
            : {}),
        ...(language ? { language } : {}),
    };
}
