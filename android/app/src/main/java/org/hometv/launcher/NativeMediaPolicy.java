package org.hometv.launcher;

import java.net.URI;
import java.util.regex.Pattern;

/** Pure boundaries for the one native camera player and its authenticated bridge URL. */
public final class NativeMediaPolicy {
    private static final Pattern CAMERA = Pattern.compile("[a-z0-9_-]{1,80}");
    private static final Pattern STREAM = Pattern.compile("/api/streams/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}(?:\\.m3u8)?");
    private long generation;
    private boolean active;
    public static boolean cameraId(String id) { return id != null && CAMERA.matcher(id).matches(); }
    public static boolean quality(String value) { return "smooth".equals(value) || "hd".equals(value); }
    public synchronized long begin() { active = true; return ++generation; }
    public synchronized boolean current(long ticket) { return active && ticket == generation; }
    public synchronized void end() { active = false; generation++; }

    public static URI streamUrl(String base, String value) {
        URI origin = OverlayProtocol.eventsUrl(base).resolve("/");
        if (value == null || value.length() > 600 || value.indexOf('\\') >= 0 || value.indexOf('%') >= 0)
            throw new IllegalArgumentException("Invalid camera stream");
        URI input = URI.create(value);
        if (input.getRawUserInfo() != null || input.getRawQuery() != null || input.getRawFragment() != null ||
            !STREAM.matcher(input.getRawPath() == null ? "" : input.getRawPath()).matches() ||
            (!input.isAbsolute() && (input.getRawAuthority() != null || !value.startsWith("/"))))
            throw new IllegalArgumentException("Invalid camera stream");
        URI result = origin.resolve(input);
        if (!origin.getScheme().equals(result.getScheme()) || result.getHost() == null ||
            !origin.getHost().equalsIgnoreCase(result.getHost()) || port(origin) != port(result))
            throw new IllegalArgumentException("Foreign camera stream");
        return result;
    }
    public static URI mediaUrl(String base, String value) {
        URI origin = OverlayProtocol.eventsUrl(base).resolve("/");
        if (value == null || value.length() > 4096 || value.indexOf('\\') >= 0 ||
            value.matches("(?s).*[\\x00-\\x20\\x7f].*") || value.toLowerCase(java.util.Locale.ROOT).matches(".*%(00|0a|0d).*"))
            throw new IllegalArgumentException("Invalid media URL");
        URI input = URI.create(value);
        if (input.getRawUserInfo() != null || input.getRawFragment() != null ||
            (!input.isAbsolute() && (input.getRawAuthority() != null || !value.startsWith("/"))))
            throw new IllegalArgumentException("Invalid media URL");
        URI result = origin.resolve(input);
        OverlayProtocol.eventsUrl(result.toString()); // HTTPS or an explicit private LAN HTTP host only.
        return result;
    }
    public static boolean sameOrigin(String base, URI value) {
        URI origin = OverlayProtocol.eventsUrl(base);
        return value != null && origin.getScheme().equals(value.getScheme()) && value.getHost() != null &&
            origin.getHost().equalsIgnoreCase(value.getHost()) && port(origin) == port(value) && value.getRawUserInfo() == null;
    }
    public static String mediaKind(String type) {
        if (type == null || type.length() > 100) return null;
        if (type.equals("audio") || type.matches("audio/[A-Za-z0-9.+-]+")) return "audio";
        if (type.equals("video") || type.equals("hls") || type.matches("video/[A-Za-z0-9.+-]+") ||
            type.equals("application/vnd.apple.mpegurl") || type.equals("application/x-mpegurl")) return "video";
        return null;
    }
    private static int port(URI uri) { return uri.getPort() >= 0 ? uri.getPort() : "https".equals(uri.getScheme()) ? 443 : 80; }
}
