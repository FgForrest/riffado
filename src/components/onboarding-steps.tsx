"use client";

import { Bot, CheckCircle2, Mic, Sparkles } from "lucide-react";
import { useExtracted } from "next-intl";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OnboardingStepWelcome() {
    const i18n = useExtracted();
    return (
        <div className="space-y-4">
            <div className="text-center space-y-2">
                <div className="size-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Mic className="size-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold">
                    {i18n("Your AI-Powered Recording Hub")}
                </h3>
                <p className="text-muted-foreground">
                    {i18n(
                        "Riffado helps you manage, transcribe, and enhance your Plaud recordings with AI. Let's set up your account.",
                    )}
                </p>
            </div>

            <div className="grid gap-4">
                <Card className="gap-0 py-4">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Mic className="size-4" />{" "}
                            {i18n("Connect Your Account")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Sign in with your Plaud email to sync recordings automatically",
                            )}
                        </p>
                    </CardContent>
                </Card>

                <Card className="gap-0 py-4">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Bot className="size-4" />{" "}
                            {i18n("Set Up AI Provider")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "Configure an AI provider for automatic transcriptions",
                            )}
                        </p>
                    </CardContent>
                </Card>

                <Card className="gap-0 py-4">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Sparkles className="size-4" />{" "}
                            {i18n("Start Recording")}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "You're all set! Start recording and let AI do the work",
                            )}
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function OnboardingStepPlaud({
    hasPlaudConnection,
    onReconnect,
    onConnected,
}: {
    hasPlaudConnection: boolean;
    onReconnect: () => void;
    onConnected: () => void;
}) {
    const i18n = useExtracted();
    return (
        <div className="space-y-4">
            <div className="text-center space-y-2">
                <div className="size-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Mic className="size-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold">
                    {i18n("Connect Your Plaud Account")}
                </h3>
                <p className="text-muted-foreground">
                    {i18n(
                        "Sign in with your Plaud email to sync recordings automatically",
                    )}
                </p>
            </div>

            {hasPlaudConnection ? (
                <Card className="border-primary/50 bg-primary/5 py-3">
                    <CardContent className="px-4">
                        <div className="flex items-center gap-3">
                            <CheckCircle2 className="size-5 text-primary" />
                            <div className="flex-1">
                                <p className="font-medium">
                                    {i18n("Device Connected")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {i18n("Your Plaud account is connected")}
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onReconnect}
                            >
                                {i18n("Reconnect")}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <Card className="gap-0 py-4">
                    <CardContent className="pt-6">
                        <PlaudConnectTabs onConnected={onConnected} />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export function OnboardingStepAiProvider({
    hasOwnProvider,
    hasIncludedProvider,
    onGoToSettings,
}: {
    hasOwnProvider: boolean;
    hasIncludedProvider: boolean;
    onGoToSettings: () => void;
}) {
    const i18n = useExtracted();
    const includedOnly = hasIncludedProvider && !hasOwnProvider;
    return (
        <div className="space-y-4">
            <div className="text-center space-y-2">
                <div className="size-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Bot className="size-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold">
                    {includedOnly
                        ? i18n("Transcription Included")
                        : i18n("Set Up AI Provider")}
                </h3>
                <p className="text-muted-foreground">
                    {includedOnly
                        ? i18n(
                              "Mynah transcription comes with your plan. You're ready to go.",
                          )
                        : i18n(
                              "Configure an AI provider to enable automatic transcriptions",
                          )}
                </p>
            </div>

            {hasOwnProvider ? (
                <Card className="border-primary/50 bg-primary/5 py-3">
                    <CardContent>
                        <div className="flex items-center gap-3">
                            <CheckCircle2 className="size-5 text-primary" />
                            <div className="flex-1">
                                <p className="font-medium">
                                    {i18n("AI Provider Configured")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "You already have your own AI provider set up",
                                    )}
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            ) : includedOnly ? (
                <Card className="border-primary/50 bg-primary/5 gap-0 py-4">
                    <CardContent className="pt-6 space-y-4">
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div className="flex-1">
                                <p className="font-medium">
                                    {i18n("Mynah transcription is included")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Transcription works out of the box with your plan. Adding your own AI provider is optional. Use it for summaries or a different transcription engine alongside Mynah.",
                                    )}
                                </p>
                            </div>
                        </div>
                        <Button
                            onClick={onGoToSettings}
                            variant="outline"
                            className="w-full"
                        >
                            {i18n("Add your own provider (optional)")}
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <Card className="gap-0 py-4">
                    <CardContent className="pt-6 space-y-4">
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "You can set up an AI provider later in Settings. This enables automatic transcription of your recordings.",
                            )}
                        </p>
                        <Button
                            onClick={onGoToSettings}
                            variant="outline"
                            className="w-full"
                        >
                            {i18n("Go to Settings")}
                        </Button>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export function OnboardingStepComplete({
    hasIncludedProvider,
}: {
    hasIncludedProvider: boolean;
}) {
    const i18n = useExtracted();
    return (
        <div className="space-y-4">
            <div className="text-center space-y-2">
                <div className="size-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                    <CheckCircle2 className="size-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold">
                    {i18n("You're All Set!")}
                </h3>
                <p className="text-muted-foreground">
                    {i18n("Start recording and let Riffado handle the rest")}
                </p>
            </div>

            <Card className="gap-0 py-4">
                <CardContent>
                    <div className="space-y-3">
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    {i18n("Recordings sync automatically")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Your Plaud device will sync recordings in the background",
                                    )}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    {i18n("AI-powered transcriptions")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {hasIncludedProvider
                                        ? i18n(
                                              "Mynah transcription is ready with your plan",
                                          )
                                        : i18n(
                                              "Set up an AI provider to transcribe recordings automatically",
                                          )}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    {i18n("Customize your experience")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Adjust settings anytime from the Settings menu",
                                    )}
                                </p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
