package org.hometv.launcher;

/** The household doorbell may preview/open only one of the configured camera identities. */
public final class NativeDoorbellPolicy {
    public static final long PREVIEW_MS = 12000L;
    public static final long SNAPSHOT_INTERVAL_MS = 1000L;
    private NativeDoorbellPolicy() {}
    public static boolean cameraId(String value) {
        return "entrance".equals(value) || "cars".equals(value) || "garden".equals(value) || "outside".equals(value);
    }
}
