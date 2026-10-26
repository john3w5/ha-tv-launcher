package org.hometv.launcher;

public final class NativeAutoQualityPolicyTest {
    private static int assertions;
    private static void check(boolean condition) { assertions++; if (!condition) throw new AssertionError("Check " + assertions); }
    private static NativeAutoQualityPolicy automatic() { var p = new NativeAutoQualityPolicy(); p.select("auto"); return p; }
    private static void promote(NativeAutoQualityPolicy p, long start) {
        p.sessionStarted(start);
        check(!p.observe(start, 0, 0, 0, 0));
        for (int i = 1; i < 8; i++) check(!p.observe(start + i * 10000L, i * 150L, 0, 0, 0));
        check(p.observe(start + 80000, 1200, 0, 0, 0));
        check("hd".equals(p.profile()));
    }
    public static void main(String[] args) {
        check(NativeAutoQualityPolicy.validMode("auto")); check(NativeAutoQualityPolicy.validMode("smooth")); check(NativeAutoQualityPolicy.validMode("hd"));
        for (String mode : new String[] { null, "HD", "", "auto&quality=hd" }) check(!NativeAutoQualityPolicy.validMode(mode));
        var p = automatic(); check("smooth".equals(p.profile())); promote(p, 0);
        // Warm-up has no adaptation; two subsequent genuinely degraded intervals can downgrade.
        check(!p.observe(90000, 0, 0, 0, 0)); check(!p.observe(100000, 100, 0, 2, 1500));
        check(!p.observe(110000, 200, 0, 4, 3000)); check(p.observe(120000, 300, 0, 6, 4500)); check("smooth".equals(p.profile()));
        check(!p.observe(130000, 0, 0, 0, 0));
        for (int i = 1; i <= 28; i++) check(!p.observe(130000 + i * 10000L, i * 150L, 0, 0, 0));
        check(p.observe(420000, 29 * 150, 0, 0, 0)); check("hd".equals(p.profile()));
        // Explicit modes never change from degradation or a transport failure.
        p.select("hd"); p.failed(1); check("hd".equals(p.profile())); check(!p.observe(2, 0, 0, 0, 0)); check(!p.observe(10002, 100, 100, 5, 5000));
        p.select("smooth"); check(!p.observe(0, 0, 0, 0, 0)); check(!p.observe(60000, 900, 0, 0, 0)); check("smooth".equals(p.profile()));
        p = automatic(); promote(p, 0); p.failed(90000); check("smooth".equals(p.profile()));
        // Two small startup freezes totaling <0.5 s plus normal 5% drops must not downgrade HD.
        p = automatic(); promote(p, 0); check(!p.observe(90000, 112, 6, 2, 489));
        for (int i = 1; i <= 7; i++) check(!p.observe(90000 + i * 10000L, 112 + i * 150, 6 + i * 8, 2, 489));
        check("hd".equals(p.profile()));
        // Actual >500ms decoded-arrival gaps and real significant packet loss are independent evidence.
        p = automatic(); promote(p, 0); check(!p.observe(90000, 0, 0, 0, 0, 0, 0, 0)); check(!p.observe(100000, 100, 0, 0, 0, 0, 0, 500));
        check(!p.observe(110000, 200, 0, 0, 0, 1, 0, 1000)); check(p.observe(120000, 300, 0, 0, 0, 2, 0, 1500));
        p = automatic(); promote(p, 0); check(!p.observe(90000, 0, 0, 0, 0, 0, 0, 0)); check(!p.observe(100000, 100, 0, 0, 0, 0, 0, 500));
        check(!p.observe(110000, 200, 0, 0, 0, 0, 20, 1000)); check(p.observe(120000, 300, 0, 0, 0, 0, 40, 1500));
        // Missing, stale, reset and non-finite counters never count as a clean minute.
        p = automatic(); check(!p.observe(0, 0, 0, 0, 0)); check(!p.observe(10000, 150, 0, 0, 0)); check(!p.observe(20000, -1, 0, 0, 0));
        check(!p.observe(30000, 450, 0, 0, 0)); check(!p.observe(40000, 0, 0, 0, 0)); check(!p.observe(50000, 150, 0, 0, Double.NaN));
        check(!p.observe(60000, 150, 0, 0, Double.POSITIVE_INFINITY)); check(!p.observe(70000, 300, 0, 0, 0)); check(!p.observe(100000, 750, 0, 0, 0)); check("smooth".equals(p.profile()));
        // Recovery budget is shared across automatic profile switches and progress resets.
        var recovery = new NativeCameraRecoveryPolicy(); recovery.resetAll(0);
        check(recovery.reserveRetry(0) == 1000); check(recovery.reserveRetry(10000) == 3000); check(recovery.reserveRetry(20000) == -1);
        recovery.resetProgress(25000); check(recovery.reserveRetry(30000) == -1); check(recovery.reserveRetry(300000) == 3000);
        System.out.println("PASS " + assertions + " automatic-quality and bounded-recovery assertions");
    }
}
