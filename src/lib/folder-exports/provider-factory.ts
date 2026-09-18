import { env } from "@/lib/env";
import { FilesystemExportProvider } from "./filesystem-provider";
import type { FolderExportProviderType } from "./types";

export function createExportProvider(
    provider: FolderExportProviderType,
): FilesystemExportProvider {
    switch (provider) {
        case "filesystem":
            return new FilesystemExportProvider(
                env.FILESYSTEM_EXPORT_ROOT ?? "",
            );
    }
}
