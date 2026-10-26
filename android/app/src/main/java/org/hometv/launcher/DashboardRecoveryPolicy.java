package org.hometv.launcher;

/** A finite recovery window. Cancelled/healthy/paused screens never consume an attempt. */
public final class DashboardRecoveryPolicy {
    private static final long[] DELAYS_MS = {1000, 3000, 8000, 15000, 30000, 30000};
    public static final class Ticket {
        public final long delayMs;
        private final long generation;
        private Ticket(long delayMs, long generation) { this.delayMs = delayMs; this.generation = generation; }
    }
    private int attempts;
    private long generation;
    private Ticket pending;
    public Ticket schedule(boolean eligible) {
        if (!eligible) { cancel(); return null; }
        if (pending != null || attempts >= DELAYS_MS.length) return null;
        return pending = new Ticket(DELAYS_MS[attempts], generation);
    }
    public boolean fire(Ticket ticket, boolean eligible) {
        if (ticket == null || pending != ticket) return false;
        pending = null;
        if (!eligible || ticket.generation != generation || attempts >= DELAYS_MS.length) return false;
        attempts++; return true;
    }
    public void cancel() { generation++; pending = null; }
    public void reset() { cancel(); attempts = 0; }
    public int attempts() { return attempts; }
}
