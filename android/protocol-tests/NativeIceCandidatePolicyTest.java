package org.hometv.launcher;

import java.util.List;

public final class NativeIceCandidatePolicyTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("ICE target check " + checks); }
    private static String section(String kind, String mid) { return "m=" + kind + " 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:" + mid + "\r\n"; }
    public static void main(String[] args) {
        List<NativeIceCandidatePolicy.Target> single = NativeIceCandidatePolicy.mediaSections("v=0\r\n" + section("video", "camera-v"));
        check(single.size() == 1);
        NativeIceCandidatePolicy.Target omitted = NativeIceCandidatePolicy.resolve(single, null, 0);
        check(omitted != null && omitted.mid.equals("camera-v") && omitted.index == 0);
        check(NativeIceCandidatePolicy.resolve(single, null, null) == omitted);
        check(NativeIceCandidatePolicy.resolve(single, "camera-v", null) == omitted);
        check(NativeIceCandidatePolicy.resolve(single, "camera-v", 0) == omitted);
        check(NativeIceCandidatePolicy.resolve(single, "0", 0) == null); // Never invent a default MID.
        for (int index : new int[]{-1, 1, 31, Integer.MAX_VALUE}) check(NativeIceCandidatePolicy.resolve(single, null, index) == null);
        for (String mid : new String[]{"", "missing", "camera-v\r\n", "x".repeat(65)}) check(NativeIceCandidatePolicy.resolve(single, mid, 0) == null);
        List<NativeIceCandidatePolicy.Target> multi = NativeIceCandidatePolicy.mediaSections("v=0\r\n" + section("audio", "a") + section("video", "v"));
        check(multi.size() == 2);
        check(NativeIceCandidatePolicy.resolve(multi, null, null) == null); // Ambiguous m-line.
        check(NativeIceCandidatePolicy.resolve(multi, "v", 0) == null); // MID/index disagree.
        check(NativeIceCandidatePolicy.resolve(multi, "a", 0) == null); // Receive-only video.
        check(NativeIceCandidatePolicy.resolve(multi, null, 1).mid.equals("v"));
        check(NativeIceCandidatePolicy.resolve(multi, "v", null).index == 1);
        for (String invalid : new String[]{null, "", "v=0\r\n", "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n", "v=0\r\n" + section("video", ""), "v=0\r\n" + section("video", "same") + section("video", "same"), "v=0\r\n" + section("video", "first") + "a=mid:second\r\n", "v=0\r\n" + section("video", "x") + "\0"}) check(NativeIceCandidatePolicy.mediaSections(invalid).isEmpty());
        System.out.println("Native ICE target policy: " + checks + " checks PASS");
    }
}
