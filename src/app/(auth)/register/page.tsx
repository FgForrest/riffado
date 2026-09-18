import { redirect } from "next/navigation";
import { getExtracted } from "next-intl/server";
import {
    HostedAuthChrome,
    SelfHostAuthChrome,
} from "@/components/auth/auth-chrome";
import { RegisterForm } from "@/components/auth/register-form";
import { emailVerificationRequired } from "@/lib/auth";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { env } from "@/lib/env";

export default async function RegisterPage() {
    const i18n = await getExtracted();
    await redirectIfAuthenticated();

    // Per product decision: when registration is disabled, redirect to
    // /login rather than rendering a "registration disabled" panel. The
    // dangling deep-link is the only meaningful entry point, and a
    // redirect is a less confusing landing than a dead-end card.
    if (env.DISABLE_REGISTRATION) {
        redirect("/login");
    }

    if (env.IS_HOSTED) {
        return (
            <HostedAuthChrome
                title={i18n("Create your account")}
                subtitle={i18n(
                    "Free to start. Upgrade only when you outgrow it.",
                )}
            >
                <RegisterForm
                    requireEmailVerification={emailVerificationRequired}
                />
            </HostedAuthChrome>
        );
    }

    return (
        <SelfHostAuthChrome
            title={i18n("Create your account")}
            subtitle={i18n(
                "The first account on a new Riffado instance becomes the admin.",
            )}
        >
            <RegisterForm
                requireEmailVerification={emailVerificationRequired}
            />
        </SelfHostAuthChrome>
    );
}
