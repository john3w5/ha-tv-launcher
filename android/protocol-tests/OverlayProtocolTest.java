package org.hometv.launcher;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Runs on the existing host JDK, without Android/JUnit dependencies or TV/network access. */
public final class OverlayProtocolTest {
    private static int checks = 0;
    private static void check(boolean condition) { checks++; if (!condition) throw new AssertionError("Check " + checks + " failed"); }
    private static List<OverlayProtocol.Event> parse(String value) throws IOException {
        List<OverlayProtocol.Event> result = new ArrayList<>();
        OverlayProtocol.readEvents(new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)), result::add);
        return result;
    }
    private static void rejected(Runnable action) {
        try { action.run(); throw new AssertionError("Unsafe input accepted"); }
        catch (IllegalArgumentException expected) { checks++; }
    }
    public static void main(String[] args) throws Exception {
        String session = "abcDEF1234567890_-abcDEF1234567890";
        check(OverlayProtocol.sessionCookie("other=private; tv_session=" + session).equals("tv_session=" + session));
        for (String raw : new String[] { null, "", "tv_session=short", "tv_session=" + session + "\r\nInjected: true",
            "tv_session=" + session + "; tv_session=" + session, "ha_token=must-not-be-sent", "tv_session=\"" + session + "\"" }) {
            check(OverlayProtocol.sessionCookie(raw) == null);
        }
        check(OverlayProtocol.eventsUrl("http://home-tv.local:4317/page?x=1").equals(URI.create("http://home-tv.local:4317/api/events")));
        check(OverlayProtocol.snapshotUrl("https://home.example.test/base", "front_door-2").equals(URI.create("https://home.example.test/api/cameras/front_door-2/snapshot")));
        for (String camera : new String[] { null, "", "../private", "a/b", "a%2fb", "//evil.test", "front?token=x", "front#x", "Camera", "a".repeat(81) }) {
            rejected(() -> OverlayProtocol.snapshotUrl("http://home-tv.local:4317/", camera));
        }
        for (String base : new String[] { "javascript:alert(1)", "file:///private/data", "http://evil.example/", "https://user:secret@home.example/", "https://home.example/#x", "http://home-tv.local:99999/" }) {
            rejected(() -> OverlayProtocol.eventsUrl(base));
        }
        List<OverlayProtocol.Event> events = parse(": heartbeat\r\nevent: notification\r\ndata: {\"message\":\"Dobrý den\"}\r\n\r\nevent: doorbell\ndata: {\n\ndata: ignored\n\nevent: ha_notification_status\ndata: {}\n\n");
        check(events.size() == 2); check(events.get(0).type.equals("notification")); check(events.get(0).data.contains("Dobrý den"));
        check(events.get(1).type.equals("doorbell"));
        events = parse("event: doorbell\ndata: {\ndata: \"cameraId\":\"front\"}\n\n");
        check(events.size() == 1); check(events.get(0).data.equals("{\n\"cameraId\":\"front\"}"));
        check(parse("event: notification\ndata: {\"message\":\"unfinished\"}").isEmpty());
        check(parse("event: notification\n\n: comment\n\n").isEmpty());
        try { parse("data: " + "a".repeat(OverlayProtocol.MAX_EVENT_CHARS + 1)); throw new AssertionError("Unbounded line accepted"); }
        catch (IOException expected) { checks++; }
        try { parse("data: " + "a".repeat(9000) + "\ndata: " + "b".repeat(9000) + "\n\n"); throw new AssertionError("Unbounded frame accepted"); }
        catch (IOException expected) { checks++; }
        check(parse("event: command\ndata: {\"exec\":\"must-not-dispatch\"}\n\n").isEmpty());
        events = parse("event: play\ndata: {\"url\":\"https://media.example/video.mp4\",\"type\":\"video/mp4\"}\n\n");
        check(events.size() == 1 && events.get(0).type.equals("play"));
        check(parse("event: play\ndata: {\"url\":\"unfinished\"}").isEmpty());
        events = parse("event: client_settings\ndata: {\"theme\":\"dark\"}\n\nevent: power\ndata: {\"action\":\"off\"}\n\nevent: power_status\ndata: {\"connected\":false}\n\n");
        check(events.size() == 3);
        check(events.get(0).type.equals("client_settings")); check(events.get(0).data.contains("theme"));
        check(events.get(1).type.equals("power")); check(events.get(2).type.equals("power_status"));
        check(parse("event: power\ndata: {\"action\":\"unfinished\"}").isEmpty());
        check(parse("event: notification_remove\ndata: {\"id\":\"old\"}\n\nevent: command\ndata: {\"exec\":\"never\"}\n\n").isEmpty());
        for (String camera : new String[] { "entrance", "cars", "garden", "outside" }) check(NativeDoorbellPolicy.cameraId(camera));
        for (String camera : new String[] { null, "", "front", "Entrance", "../entrance", "entrance?open=other", "com.netflix.ninja", "https://other.example/", "cars\n" }) check(!NativeDoorbellPolicy.cameraId(camera));
        check(NativeDoorbellPolicy.PREVIEW_MS == 12000L); check(NativeDoorbellPolicy.SNAPSHOT_INTERVAL_MS == 1000L);
        System.out.println("Overlay protocol: " + checks + " checks passed");
    }
}
