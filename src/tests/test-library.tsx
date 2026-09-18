import {
    render as baseRender,
    type RenderOptions,
} from "@testing-library/react/pure";
import type { PropsWithChildren } from "react";
import { IntlProvider } from "use-intl/react";
import { defaultLocale } from "@/lib/i18n/config";
import { messagesForLocale } from "@/lib/i18n/messages";

export * from "@testing-library/react/pure";

function EnglishLocaleProvider({ children }: PropsWithChildren) {
    return (
        <IntlProvider
            locale={defaultLocale}
            messages={messagesForLocale(defaultLocale)}
        >
            {children}
        </IntlProvider>
    );
}

export function render(
    ui: Parameters<typeof baseRender>[0],
    options?: RenderOptions,
): ReturnType<typeof baseRender> {
    const ExistingWrapper = options?.wrapper;
    return baseRender(ui, {
        ...options,
        wrapper: ({ children }: PropsWithChildren) => (
            <EnglishLocaleProvider>
                {ExistingWrapper ? (
                    <ExistingWrapper>{children}</ExistingWrapper>
                ) : (
                    children
                )}
            </EnglishLocaleProvider>
        ),
    });
}
