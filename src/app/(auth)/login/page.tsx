import { getExtracted } from "next-intl/server";
import {
    HostedAuthChrome,
    SelfHostAuthChrome,
} from "@/components/auth/auth-chrome";
import { LoginForm } from "@/components/auth/login-form";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";

export default async function LoginPage() {
    const i18n = await getExtracted();
    await redirectIfAuthenticated();

    const formProps = {
        registrationEnabled: !env.DISABLE_REGISTRATION,
        smtpConfigured: isSmtpConfigured(),
    };

    if (env.IS_HOSTED) {
        return (
            <HostedAuthChrome
                title={i18n("Sign in")}
                subtitle={i18n("Welcome back to Riffado.")}
            >
                <LoginForm {...formProps} />
            </HostedAuthChrome>
        );
    }

    return (
        <SelfHostAuthChrome
            title={i18n("Sign in")}
            subtitle={i18n("Sign in to your Riffado instance.")}
        >
            <LoginForm {...formProps} />
        </SelfHostAuthChrome>
    );
}
