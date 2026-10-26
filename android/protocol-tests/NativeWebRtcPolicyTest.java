package org.hometv.launcher;
public final class NativeWebRtcPolicyTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("RTC policy failed"); }
    public static void main(String[] args) {
        var origin = NativeWebRtcPolicy.origin("http://home-tv.local:4317/");
        check(NativeWebRtcPolicy.offer(origin,"entrance").toString().equals("http://home-tv.local:4317/api/cameras/entrance/webrtc"));
        String session = "a".repeat(32);
        check(NativeWebRtcPolicy.session(origin,session,"events").getPath().equals("/api/webrtc/"+session+"/events"));
        for (String base : new String[]{"http://public.example/", "http://user:pass@home-tv.local:4317/", "https://example.test/path", "https://example.test/?token=x", "file:///private/", "https://example.test/#fragment"}) {
            try { NativeWebRtcPolicy.origin(base); throw new AssertionError("Invalid origin"); } catch (IllegalArgumentException expected) { checks++; }
        }
        check(NativeWebRtcPolicy.sdp("v=0\r\ns=receive only\r\n"));
        for (String sdp : new String[]{"", "not SDP", "v=0\n"+"x".repeat(60000), "v=0\n\0"}) check(!NativeWebRtcPolicy.sdp(sdp));
        check(NativeWebRtcPolicy.cameraId("entrance") && !NativeWebRtcPolicy.cameraId("../entrance"));
        check(NativeWebRtcPolicy.sessionId(session) && !NativeWebRtcPolicy.sessionId("../secret"));
        check(NativeWebRtcPolicy.quality("smooth") && NativeWebRtcPolicy.quality("hd") && !NativeWebRtcPolicy.quality("auto"));
        check(NativeWebRtcPolicy.candidate("") && NativeWebRtcPolicy.candidate("candidate:1 1 udp 1 192.0.2.1 123 typ host"));
        for (String candidate : new String[]{"x".repeat(4097), "candidate:x\r\nOrigin: bad", "\0"}) check(!NativeWebRtcPolicy.candidate(candidate));
        check(NativeWebRtcPolicy.mid("video_0") && !NativeWebRtcPolicy.mid("x".repeat(65)) && !NativeWebRtcPolicy.mid("../0"));
        check(NativeWebRtcPolicy.line(0) && NativeWebRtcPolicy.line(31));
        for (double invalid : new double[]{-1,32,1.5,Double.NaN,Double.POSITIVE_INFINITY}) check(!NativeWebRtcPolicy.line(invalid));
        check(NativeWebRtcPolicy.fragment("abc+/0_-") && !NativeWebRtcPolicy.fragment("abc\n"));
        try { NativeWebRtcPolicy.session(origin,session,"../../services"); throw new AssertionError("Invalid operation"); } catch (IllegalArgumentException expected) { checks++; }
        System.out.println("NativeWebRtcPolicy: "+checks+" assertions passed.");
    }
}
