package org.hometv.launcher;

/** Camera-only profile hysteresis based on monotonic, real inbound-video counters. */
public final class NativeAutoQualityPolicy {
    private static final long PROMOTE_AFTER_MS = 60000L;
    private static final long DOWNGRADE_HOLD_MS = 300000L;
    private static final long WARMUP_MS = 15000L;
    private String mode = "smooth";
    private String profile = "smooth";
    private long holdUntil;
    private long cleanMs;
    private int badSamples;
    private long previousAt = -1;
    private long previousDecoded;
    private long previousDropped;
    private long previousFreezes;
    private double previousFreezeMs;
    private long previousLargeGaps;
    private long previousLost;
    private long previousReceived;
    private long warmupUntil;

    public static boolean validMode(String value) {
        return "auto".equals(value) || "smooth".equals(value) || "hd".equals(value);
    }

    /** An explicit user choice starts a new hysteresis window; Auto starts conservatively. */
    public void select(String value) {
        if (!validMode(value)) throw new IllegalArgumentException("Invalid camera quality mode");
        mode = value;
        profile = "hd".equals(value) ? "hd" : "smooth";
        holdUntil = 0;
        sessionStarted(0);
    }

    public String mode() { return mode; }
    public String profile() { return profile; }

    /** A new peer has new cumulative counters; never compare them with its predecessor. */
    public void sessionStarted(long now) {
        previousAt = -1;
        cleanMs = 0;
        badSamples = 0;
        warmupUntil = Math.max(0, now) + WARMUP_MS;
    }

    /** A failed automatic HD session retries the cheaper profile; explicit HD stays explicit. */
    public void failed(long now) {
        if ("auto".equals(mode) && "hd".equals(profile)) downgrade(now);
        sessionStarted(now);
    }

    /** Returns true only when a fresh peer with the returned profile is required. */
    public boolean observe(long now, long decoded, long dropped, long freezes, double freezeMs) {
        return observe(now, decoded, dropped, freezes, freezeMs, -1, -1, -1);
    }

    public boolean observe(long now, long decoded, long dropped, long freezes, double freezeMs,
                           long largeGaps, long lost, long received) {
        if (!"auto".equals(mode)) return false;
        if (now < 0 || decoded < 0 || dropped < 0 || freezes < 0 || !Double.isFinite(freezeMs) || freezeMs < 0) {
            previousAt = -1; cleanMs = 0; badSamples = 0;
            return false;
        }
        long elapsed = previousAt < 0 ? 0 : now - previousAt;
        long decodedDelta = decoded - previousDecoded;
        long droppedDelta = dropped - previousDropped;
        long freezeDelta = freezes - previousFreezes;
        double freezeMsDelta = freezeMs - previousFreezeMs;
        long largeGapDelta = largeGaps >= 0 && previousLargeGaps >= 0 ? largeGaps - previousLargeGaps : -1;
        long lostDelta = lost >= 0 && previousLost >= 0 ? lost - previousLost : -1;
        long receivedDelta = received >= 0 && previousReceived >= 0 ? received - previousReceived : -1;
        boolean comparable = previousAt >= warmupUntil && elapsed > 0 && elapsed <= 20000 &&
                decodedDelta >= 0 && droppedDelta >= 0 && freezeDelta >= 0 && freezeMsDelta >= 0;
        previousAt = now;
        previousDecoded = decoded;
        previousDropped = dropped;
        previousFreezes = freezes;
        previousFreezeMs = freezeMs;
        previousLargeGaps = largeGaps;
        previousLost = lost;
        previousReceived = received;
        if (!comparable || decodedDelta == 0) { cleanMs = 0; badSamples = 0; return false; }

        boolean packetLoss = lostDelta >= 10 && receivedDelta > 0 && lostDelta / (double) (receivedDelta + lostDelta) >= .02;
        boolean bad = freezeMsDelta > 1000 || largeGapDelta > 0 || packetLoss ||
                decodedDelta >= 20 && droppedDelta / (double) (decodedDelta + droppedDelta) >= .15;
        if (bad) {
            cleanMs = 0;
            if (++badSamples >= 2 && "hd".equals(profile)) { downgrade(now); sessionStarted(now); return true; }
        } else {
            badSamples = 0;
            // Promotion needs actual progress and completely clean reported counters.
            if (freezeDelta == 0 && freezeMsDelta == 0 && droppedDelta <= 1) cleanMs += elapsed;
            else cleanMs = 0;
            if ("smooth".equals(profile) && now >= holdUntil && cleanMs >= PROMOTE_AFTER_MS) {
                profile = "hd";
                sessionStarted(now);
                return true;
            }
        }
        return false;
    }

    private void downgrade(long now) {
        profile = "smooth";
        holdUntil = now > Long.MAX_VALUE - DOWNGRADE_HOLD_MS ? Long.MAX_VALUE : now + DOWNGRADE_HOLD_MS;
    }
}
