package org.hometv.launcher;

/** One current read-only catalog task; lifecycle changes invalidate old worker results. */
public final class NativeCatalogPolicy {
    public static final class Ticket {
        private final long generation;
        private Ticket(long generation) { this.generation = generation; }
    }
    private long generation;
    private boolean pending;
    public Ticket schedule(boolean eligible) {
        if (!eligible) { cancel(); return null; }
        if (pending) return null;
        pending = true;
        return new Ticket(++generation);
    }
    public boolean complete(Ticket ticket, boolean eligible) {
        if (ticket == null || !pending || ticket.generation != generation) return false;
        pending = false;
        if (!eligible) { generation++; return false; }
        return true;
    }
    public void cancel() { generation++; pending = false; }
}
