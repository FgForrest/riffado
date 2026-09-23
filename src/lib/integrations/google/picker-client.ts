const API_SCRIPT = "https://apis.google.com/js/api.js";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface PickerDocument {
    id: string;
    name?: string;
}

interface PickerResponse {
    action: string;
    docs?: PickerDocument[];
}

interface DocsView {
    setSelectFolderEnabled(enabled: boolean): DocsView;
    setIncludeFolders(included: boolean): DocsView;
    setMimeTypes(mimeTypes: string): DocsView;
    setEnableDrives(enabled: boolean): DocsView;
}

interface Picker {
    setVisible(visible: boolean): void;
    dispose(): void;
}

interface PickerBuilder {
    addView(view: DocsView): PickerBuilder;
    enableFeature(feature: string): PickerBuilder;
    setOAuthToken(token: string): PickerBuilder;
    setDeveloperKey(key: string): PickerBuilder;
    setAppId(appId: string): PickerBuilder;
    setTitle(title: string): PickerBuilder;
    setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
    build(): Picker;
}

interface PickerApi {
    DocsView: new (viewId: string) => DocsView;
    PickerBuilder: new () => PickerBuilder;
    ViewId: { FOLDERS: string };
    Feature: { SUPPORT_DRIVES: string };
    Action: { PICKED: string; CANCEL: string };
}

interface PickerWindow {
    gapi?: {
        load(
            name: string,
            options: { callback: () => void; onerror: () => void },
        ): void;
    };
    google?: { picker?: PickerApi };
}

let loading: Promise<PickerApi> | null = null;

function loadPickerApi(): Promise<PickerApi> {
    loading ??= new Promise<PickerApi>((resolve, reject) => {
        const target = window as unknown as PickerWindow;
        const ready = () => {
            const api = target.google?.picker;
            if (api) resolve(api);
            else reject(new Error("The Google Picker did not load"));
        };
        const loadPicker = () => {
            if (!target.gapi) {
                reject(new Error("The Google API loader did not load"));
                return;
            }
            target.gapi.load("picker", {
                callback: ready,
                onerror: () =>
                    reject(new Error("The Google Picker did not load")),
            });
        };
        if (target.gapi) {
            loadPicker();
            return;
        }
        const script = document.createElement("script");
        script.src = API_SCRIPT;
        script.async = true;
        script.onload = loadPicker;
        script.onerror = () =>
            reject(new Error("The Google API loader did not load"));
        document.head.appendChild(script);
    }).catch((error: unknown) => {
        loading = null;
        throw error;
    });
    return loading;
}

export interface PickerCredentials {
    accessToken: string;
    apiKey: string;
    appId: string;
}

export interface PickedDriveFolder {
    id: string;
    name: string;
}

/**
 * Opens the Google Picker on folders (My Drive and shared drives) and
 * resolves with the one chosen, or null when the user cancels. Picking
 * grants the app `drive.file` access to that folder.
 */
export async function pickDriveFolder(
    credentials: PickerCredentials,
    title: string,
): Promise<PickedDriveFolder | null> {
    const api = await loadPickerApi();
    return new Promise((resolve) => {
        const view = new api.DocsView(api.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setIncludeFolders(true)
            .setMimeTypes(FOLDER_MIME)
            .setEnableDrives(true);
        const picker = new api.PickerBuilder()
            .addView(view)
            .enableFeature(api.Feature.SUPPORT_DRIVES)
            .setOAuthToken(credentials.accessToken)
            .setDeveloperKey(credentials.apiKey)
            .setAppId(credentials.appId)
            .setTitle(title)
            .setCallback((response) => {
                if (response.action === api.Action.PICKED) {
                    const folder = response.docs?.[0];
                    picker.dispose();
                    resolve(
                        folder
                            ? { id: folder.id, name: folder.name ?? folder.id }
                            : null,
                    );
                } else if (response.action === api.Action.CANCEL) {
                    picker.dispose();
                    resolve(null);
                }
            })
            .build();
        picker.setVisible(true);
    });
}
