// Loaded briefly by the local server while a soundboard pad opens Spotify.
// Keep the window that sent the command active if Spotify raises itself.
const soundboardWindow = workspace.activeWindow;

if (soundboardWindow) {
    workspace.windowActivated.connect(function (window) {
        if (!window || window === soundboardWindow || soundboardWindow.deleted) return;
        const windowClass = String(window.resourceClass || '').toLowerCase();
        const resourceName = String(window.resourceName || '').toLowerCase();
        if (windowClass.includes('spotify') || resourceName.includes('spotify')) {
            workspace.activeWindow = soundboardWindow;
        }
    });
}
