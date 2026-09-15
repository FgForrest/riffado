import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Shared sticky header shell for the signed-in application sections. */
export function AppHeader({ className, ...props }: ComponentProps<"header">) {
    return (
        <header
            className={cn(
                "sticky top-0 z-30 -mx-4 mb-6 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70",
                className,
            )}
            {...props}
        />
    );
}
