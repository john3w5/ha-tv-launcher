package org.hometv.launcher;

public final class DashboardRecoveryPolicyTest {
    private static int checks;
    private static void check(boolean condition, String message) {
        checks++; if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        DashboardRecoveryPolicy policy = new DashboardRecoveryPolicy();
        long[] expected = {1000, 3000, 8000, 15000, 30000, 30000};
        for (int i = 0; i < expected.length; i++) {
            var ticket = policy.schedule(true);
            check(ticket != null && ticket.delayMs == expected[i], "Exact finite backoff delay " + i);
            check(policy.schedule(true) == null, "Only one scheduled attempt");
            check(policy.fire(ticket, true), "A still-eligible foreground screen may retry");
            check(!policy.fire(ticket, true), "One timer cannot retry twice");
        }
        check(policy.attempts() == 6, "Six attempts consumed");
        check(policy.schedule(true) == null, "No unbounded recurrence after six attempts");
        policy.reset();
        var paused = policy.schedule(true); policy.cancel();
        check(!policy.fire(paused, true), "Pause/destroy cancels a previous timer");
        check(policy.attempts() == 0, "Cancelled work consumes no attempt");
        var covered = policy.schedule(true);
        check(!policy.fire(covered, false), "Covered or unfocused activity cannot cause a hidden retry");
        check(policy.attempts() == 0, "Ineligible foreground state does not burn an attempt");
        var healthy = policy.schedule(true);
        check(policy.schedule(false) == null, "Healthy/nonforeground state cannot schedule a reload");
        check(!policy.fire(healthy, true), "Becoming healthy invalidates old work");
        var network = policy.schedule(true); policy.reset();
        var renewed = policy.schedule(true);
        check(!policy.fire(network, true), "A new window invalidates the old network callback");
        check(renewed.delayMs == 1000, "Resume/manual/network recovery gets a new first delay");
        check(policy.fire(renewed, true), "Only the current window may fire");
        check(policy.attempts() == 1, "The renewed attempt is counted once");
        check(!policy.fire(null, true), "No invented recovery work");
        System.out.println("DashboardRecoveryPolicy: " + checks + " assertions passed.");
    }
}
