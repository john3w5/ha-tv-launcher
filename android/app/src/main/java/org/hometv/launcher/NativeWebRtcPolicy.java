package org.hometv.launcher;

import java.net.URI;

/** Fixed, same-origin read-only camera signalling routes. No arbitrary URL or device action. */
public final class NativeWebRtcPolicy {
    private NativeWebRtcPolicy() {}
    public static URI origin(String base) {
        URI input = URI.create(base);
        if (input.getRawQuery() != null || input.getRawFragment() != null || input.getRawUserInfo() != null ||
            !(input.getPath() == null || input.getPath().isEmpty() || input.getPath().equals("/"))) throw new IllegalArgumentException("Invalid camera origin");
        return OverlayProtocol.eventsUrl(base).resolve("/");
    }
    public static boolean cameraId(String id) { return id != null && id.matches("[a-z0-9_-]{1,80}"); }
    public static boolean sessionId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{32}"); }
    public static boolean quality(String value) { return "smooth".equals(value) || "hd".equals(value); }
    public static boolean sdp(String value) { return value != null && value.length() <= 60000 && value.matches("(?s)^v=0\\r?\\n.*") && value.indexOf('\0') < 0; }
    public static boolean candidate(String value) { return value != null && value.length() <= 4096 && value.indexOf('\0') < 0 && value.indexOf('\r') < 0 && value.indexOf('\n') < 0; }
    public static boolean mid(String value) { return value != null && value.matches("[a-zA-Z0-9_-]{1,64}"); }
    public static boolean fragment(String value) { return value != null && value.matches("[a-zA-Z0-9+/_-]{1,256}"); }
    public static boolean line(double value) { return Double.isFinite(value) && value >= 0 && value <= 31 && value == Math.floor(value); }
    public static URI offer(URI origin, String id) {
        if (!cameraId(id)) throw new IllegalArgumentException("Invalid camera");
        return origin.resolve("/api/cameras/" + id + "/webrtc");
    }
    public static URI session(URI origin, String id, String operation) {
        if (!sessionId(id) || !(operation.equals("") || operation.equals("events") || operation.equals("candidate"))) throw new IllegalArgumentException("Invalid camera session");
        return origin.resolve("/api/webrtc/" + id + (operation.isEmpty() ? "" : "/" + operation));
    }
}
