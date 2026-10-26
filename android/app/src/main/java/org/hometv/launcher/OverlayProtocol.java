package org.hometv.launcher;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** Small, dependency-free protocol boundaries shared by the native service and JVM tests. */
public final class OverlayProtocol {
    public static final int MAX_EVENT_CHARS = 16 * 1024;
    private static final Pattern CAMERA_ID = Pattern.compile("[a-z0-9_-]{1,80}");
    private static final Pattern SESSION = Pattern.compile("[A-Za-z0-9_-]{16,256}");
    private OverlayProtocol() {}

    public static String sessionCookie(String header) {
        if (header == null || header.length() > 8192 || header.indexOf('\r') >= 0 || header.indexOf('\n') >= 0) return null;
        String session = null;
        for (String part : header.split(";")) {
            String item = part.trim();
            if (!item.startsWith("tv_session=")) continue;
            String value = item.substring("tv_session=".length());
            if (session != null || !SESSION.matcher(value).matches()) return null;
            session = "tv_session=" + value;
        }
        return session;
    }

    public static URI eventsUrl(String base) { return endpoint(base, "/api/events"); }

    public static URI snapshotUrl(String base, String cameraId) {
        if (cameraId == null || !CAMERA_ID.matcher(cameraId).matches()) throw new IllegalArgumentException("Invalid camera ID");
        return endpoint(base, "/api/cameras/" + cameraId + "/snapshot");
    }

    private static URI endpoint(String base, String endpoint) {
        URI uri = URI.create(base);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null || uri.getRawUserInfo() != null || uri.getFragment() != null ||
            !("https".equals(scheme) || ("http".equals(scheme) && localHost(host))) ||
            (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535))) throw new IllegalArgumentException("Invalid dashboard origin");
        return uri.resolve(endpoint);
    }

    private static boolean localHost(String host) {
        if (host.equals("localhost") || host.endsWith(".local") || host.endsWith(".home.arpa")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] address = new int[4];
        try {
            for (int index = 0; index < 4; index++) {
                if (!parts[index].matches("[0-9]{1,3}")) return false;
                address[index] = Integer.parseInt(parts[index]);
                if (address[index] > 255) return false;
            }
        } catch (NumberFormatException invalid) { return false; }
        return address[0] == 10 || address[0] == 127 || (address[0] == 192 && address[1] == 168) ||
            (address[0] == 172 && address[1] >= 16 && address[1] <= 31);
    }

    public static final class Event {
        public final String type;
        public final String data;
        public Event(String type, String data) { this.type = type; this.data = data; }
    }

    /** Bounded SSE frames. EOF never dispatches a partial, unterminated event. */
    public static void readEvents(InputStream input, Consumer<Event> consumer) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8), 4096);
        String type = "message";
        StringBuilder data = new StringBuilder();
        while (!Thread.currentThread().isInterrupted()) {
            String line = readLine(reader);
            if (line == null) return;
            if (line.isEmpty()) {
                if (data.length() > 0 && (type.equals("notification") || type.equals("doorbell") || type.equals("play") ||
                        type.equals("client_settings") || type.equals("power") || type.equals("power_status"))) {
                    data.setLength(data.length() - 1);
                    consumer.accept(new Event(type, data.toString()));
                }
                type = "message";
                data.setLength(0);
                continue;
            }
            if (line.charAt(0) == ':') continue;
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if (field.equals("event")) type = value;
            else if (field.equals("data")) {
                if (data.length() + value.length() + 1 > MAX_EVENT_CHARS) throw new IOException("SSE event exceeds limit");
                data.append(value).append('\n');
            }
        }
    }

    private static String readLine(BufferedReader reader) throws IOException {
        StringBuilder line = new StringBuilder();
        int character;
        while ((character = reader.read()) != -1) {
            if (character == '\n') return line.toString();
            if (character == '\r') {
                reader.mark(1);
                if (reader.read() != '\n') reader.reset();
                return line.toString();
            }
            if (line.length() >= MAX_EVENT_CHARS) throw new IOException("SSE line exceeds limit");
            line.append((char) character);
        }
        return line.length() == 0 ? null : line.toString();
    }
}
