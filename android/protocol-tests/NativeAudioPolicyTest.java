package org.hometv.launcher;

public final class NativeAudioPolicyTest {
    private static int checks;
    private static void check(boolean condition, String message) {
        checks++; if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        NativeAudioPolicy policy = new NativeAudioPolicy();
        check(policy.request(NativeAudioPolicy.Kind.MOVE, 1000) == null, "Inactive screen cannot read a sound preference");
        policy.setActive(true);
        var first = policy.request(NativeAudioPolicy.Kind.MOVE, 1000);
        check(first != null && first.kind == NativeAudioPolicy.Kind.MOVE, "One known key kind is admitted");
        check(first.issuedAtMs() == 1000, "Diagnostic age uses actual request uptime");
        check(policy.request(NativeAudioPolicy.Kind.SELECT, 1060) == null, "A pending read has no queue");
        check(policy.request(NativeAudioPolicy.Kind.SELECT, 100000) == null, "A hung renderer still cannot accumulate reads");
        check(policy.authorize(first, "true", 1020), "Fresh exact boolean permits one sound");
        check(!policy.authorize(first, "true", 1021), "Callback replay cannot play twice");
        check(policy.request(NativeAudioPolicy.Kind.MOVE, 1059) == null, "Request repetition is limited to 60 ms");
        var earlyPlay = policy.request(NativeAudioPolicy.Kind.SELECT, 1060);
        check(earlyPlay != null, "Request threshold is inclusive at 60 ms");
        check(!policy.authorize(earlyPlay, "true", 1070), "Delayed callbacks cannot play sounds less than 60 ms apart");
        var quoted = policy.request(NativeAudioPolicy.Kind.SELECT, 1120);
        check(!policy.authorize(quoted, "\"true\"", 1130), "A string is not the one allowed boolean");
        var falseValue = policy.request(NativeAudioPolicy.Kind.MOVE, 1180);
        check(!policy.authorize(falseValue, "false", 1200), "Disabled setting never plays");
        var late = policy.request(NativeAudioPolicy.Kind.MOVE, 1240);
        check(!policy.authorize(late, "true", 1321), "An 81 ms response is discarded");
        var boundary = policy.request(NativeAudioPolicy.Kind.MOVE, 1400);
        check(policy.authorize(boundary, "true", 1480), "An 80 ms response is still within the explicit bound");
        var reload = policy.request(NativeAudioPolicy.Kind.MOVE, 1500);
        policy.invalidate();
        check(!policy.authorize(reload, "true", 1510), "Page reload invalidates the previous callback");
        var paused = policy.request(NativeAudioPolicy.Kind.SELECT, 1600);
        policy.setActive(false);
        check(!policy.authorize(paused, "true", 1610), "Background activity cannot emit a late sound");
        check(policy.request(NativeAudioPolicy.Kind.MOVE, 1700) == null, "Paused activity cannot issue another read");
        policy.setActive(true);
        var resumed = policy.request(NativeAudioPolicy.Kind.SELECT, 1700);
        check(policy.authorize(resumed, "true", 1710), "A resumed screen allows a new user action");
        var backward = policy.request(NativeAudioPolicy.Kind.MOVE, 1800);
        check(!policy.authorize(backward, "true", 1799), "Negative callback age is rejected");
        check(policy.request(null, 1900) == null, "No arbitrary sound kind");
        check(policy.request(NativeAudioPolicy.Kind.MOVE, -1) == null, "No invalid uptime");
        check(!policy.authorize(null, "true", 2000), "No invented callback ticket");
        var pending = policy.request(NativeAudioPolicy.Kind.MOVE, 2000);
        check(!policy.authorize(pending, null, 2010), "Missing JavaScript result fails silent");
        System.out.println("NativeAudioPolicy: " + checks + " assertions passed.");
    }
}
