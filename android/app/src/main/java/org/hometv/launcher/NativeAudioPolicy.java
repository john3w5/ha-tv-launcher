package org.hometv.launcher;

/** Pure timing policy: one outstanding read, no queue, and no late navigation sound. */
public final class NativeAudioPolicy {
    public enum Kind { MOVE, SELECT }
    public static final long MIN_INTERVAL_MS = 60;
    public static final long MAX_CALLBACK_AGE_MS = 80;
    public static final class Ticket {
        public final Kind kind;
        private final long issuedAt;
        private final long generation;
        private Ticket(Kind kind, long issuedAt, long generation) {
            this.kind = kind; this.issuedAt = issuedAt; this.generation = generation;
        }
        public long issuedAtMs() { return issuedAt; }
    }
    private boolean active;
    private long generation;
    private long lastRequest = Long.MIN_VALUE;
    private long lastPlay = Long.MIN_VALUE;
    private Ticket pending;

    public void setActive(boolean value) { active = value; invalidate(); }
    public void invalidate() {
        generation++; pending = null; lastRequest = Long.MIN_VALUE; lastPlay = Long.MIN_VALUE;
    }
    public Ticket request(Kind kind, long now) {
        if (!active || kind == null || now < 0) return null;
        if (pending != null) return null; // Never enqueue more evaluations behind a busy renderer.
        if (lastRequest != Long.MIN_VALUE && now >= lastRequest && now - lastRequest < MIN_INTERVAL_MS) return null;
        lastRequest = now;
        return pending = new Ticket(kind, now, generation);
    }
    public boolean authorize(Ticket ticket, String exactBoolean, long now) {
        if (ticket == null || pending != ticket) return false;
        pending = null;
        if (!active || ticket.generation != generation || !"true".equals(exactBoolean)
                || now < ticket.issuedAt || now - ticket.issuedAt > MAX_CALLBACK_AGE_MS) return false;
        if (lastPlay != Long.MIN_VALUE && now >= lastPlay && now - lastPlay < MIN_INTERVAL_MS) return false;
        lastPlay = now;
        return true;
    }
}
