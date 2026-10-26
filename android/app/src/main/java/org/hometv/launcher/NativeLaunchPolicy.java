package org.hometv.launcher;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** A finite outbound navigation protocol, with no arbitrary intents, URIs, or components. */
public final class NativeLaunchPolicy {
    public enum Kind { LAUNCH, SETTINGS, VOICE }
    public static final class Action {
        public final Kind kind;
        public final String appId;
        private Action(Kind kind, String appId) { this.kind = kind; this.appId = appId; }
    }
    private static final Set<String> PACKAGES;
    static {
        LinkedHashSet<String> packages = new LinkedHashSet<>();
        Collections.addAll(packages,
            "com.netflix.ninja", "net.cme.voyo.cz.tvapp", "cz.prima.tvapp",
            "com.google.android.youtube.tv", "com.spotify.tv.android", "org.videolan.vlc",
            "com.google.android.youtube.tvmusic", "com.google.android.youtube.tvkids",
            "com.tcl.ui_mediaCenter", "com.tcl.browser", "com.tcl.gallery", "flar2.homebutton",
            "com.liskovsoft.smarttubetv.beta");
        PACKAGES = Collections.unmodifiableSet(packages);
    }
    private NativeLaunchPolicy() {}
    public static Set<String> allowedPackages() { return PACKAGES; }
    public static boolean isAllowedPackage(String appId) { return PACKAGES.contains(appId); }

    public static Action authorize(String raw, boolean mainFrame, boolean userGesture,
                                   boolean ready, boolean sameOrigin, boolean foreground,
                                   boolean getRequest, boolean redirect) {
        if (!mainFrame || !userGesture || !ready || !sameOrigin || !foreground || !getRequest || redirect)
            return null;
        // Literal equality rejects encoded delimiters, duplicate/unknown parameters,
        // credentials, ports, fragments, whitespace and case-normalization surprises.
        if ("hometv://settings".equals(raw) || "hometv://settings/".equals(raw))
            return new Action(Kind.SETTINGS, null);
        if ("hometv://voice".equals(raw) || "hometv://voice/".equals(raw))
            return new Action(Kind.VOICE, null);
        String prefix = "hometv://launch?appId=";
        if (raw == null || !raw.startsWith(prefix) || raw.length() > 180) return null;
        String appId = raw.substring(prefix.length());
        return isAllowedPackage(appId) ? new Action(Kind.LAUNCH, appId) : null;
    }

    public static boolean isLaunchable(String requested, String resolvedPackage,
                                     boolean exported, boolean activityEnabled,
                                     boolean applicationEnabled, boolean packageEnabled,
                                     boolean componentEnabled, boolean notSuspended,
                                     boolean permissionGranted) {
        return isAllowedPackage(requested) && requested.equals(resolvedPackage) &&
            exported && activityEnabled && applicationEnabled && packageEnabled &&
            componentEnabled && notSuspended && permissionGranted;
    }
}
