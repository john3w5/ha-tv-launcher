package org.hometv.launcher;

import java.net.URI;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Local packaged map document and visible OSM tiles only. No HA endpoint or remote script. */
public final class NativeFamilyMapPolicy {
    private NativeFamilyMapPolicy() {}
    public static final String DOCUMENT = "https://appassets.androidplatform.net/assets/family-map/index.html";
    private static final String PREFIX = "/assets/family-map/";
    private static final Set<String> FILES = Set.of("index.html", "family-map.js", "family-map.css", "leaflet.js", "leaflet.css",
        "images/marker-icon.png", "images/marker-icon-2x.png", "images/marker-shadow.png", "images/layers.png", "images/layers-2x.png");
    private static final Pattern TILE = Pattern.compile("^/([0-9]{1,2})/([0-9]{1,6})/([0-9]{1,6})\\.png$");
    private static URI parse(String raw) {
        if (raw == null || raw.length() > 1024 || raw.chars().anyMatch(c -> c < 32 || c == 127 || c == '\\')) return null;
        try {
            URI value = URI.create(raw);
            if (!"https".equals(value.getScheme()) || value.getHost() == null || value.isOpaque() || value.getUserInfo() != null ||
                value.getRawQuery() != null || value.getRawFragment() != null || (value.getPort() != -1 && value.getPort() != 443) ||
                !value.getRawPath().equals(value.getPath())) return null;
            return value;
        } catch (Exception ignored) { return null; }
    }
    public static String asset(String raw) {
        URI value = parse(raw);
        if (value == null || !"appassets.androidplatform.net".equals(value.getHost()) || !value.getPath().startsWith(PREFIX)) return null;
        String name = value.getPath().substring(PREFIX.length());
        return FILES.contains(name) ? "family-map/" + name : null;
    }
    public static boolean document(String raw) { return DOCUMENT.equals(raw); }
    public static boolean tile(String raw) {
        URI value = parse(raw);
        if (value == null || !"tile.openstreetmap.org".equals(value.getHost())) return false;
        Matcher match = TILE.matcher(value.getPath());
        if (!match.matches()) return false;
        int zoom = Integer.parseInt(match.group(1)), x = Integer.parseInt(match.group(2)), y = Integer.parseInt(match.group(3));
        return zoom <= 19 && x < (1 << zoom) && y < (1 << zoom);
    }
    public static boolean attribution(String raw) {
        return "https://www.openstreetmap.org/copyright".equals(raw) || "https://www.openstreetmap.org/fixthemap".equals(raw);
    }
    public static boolean coordinates(double latitude, double longitude) {
        return Double.isFinite(latitude) && Double.isFinite(longitude) && Math.abs(latitude) <= 85.05112878 && Math.abs(longitude) <= 180;
    }
}
