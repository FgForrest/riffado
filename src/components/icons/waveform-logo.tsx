import type { SVGProps } from "react";

/** Compact waveform mark for the signed-in application header. */
export function WaveformLogo(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            viewBox="0 0 36 40"
            fill="none"
            aria-hidden="true"
            focusable="false"
            {...props}
        >
            <path
                d="M3 16v8M8 11v18M13 6v28M18 12v16M23 3v34M28 10v20M33 15v10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
            />
        </svg>
    );
}
