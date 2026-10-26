package org.hometv.launcher;

import java.util.ArrayDeque;

/** Monotonic, camera-only progress checks and a bounded read-only reconnect budget. */
public final class NativeCameraRecoveryPolicy {
    private static final long STALE_MS = 6000L;
    private static final long WINDOW_MS = 300000L;
    private final ArrayDeque<Long> retries = new ArrayDeque<>();
    private long lastFrameAt;
    private long lastCount = -1;
    private boolean observedFrame;

    public void resetProgress(long now) { lastFrameAt = now; lastCount = -1; observedFrame = false; }
    public void resetAll(long now) { retries.clear(); resetProgress(now); }

    /** Initial connection has its own deadline; absence of a first frame is not a six-second freeze. */
    public boolean observe(long now, long renderedCount, boolean expectedPlaying) {
        if (!expectedPlaying) { lastFrameAt = now; lastCount = renderedCount; return false; }
        if (renderedCount > lastCount && renderedCount > 0) { observedFrame = true; lastFrameAt = now; }
        else if (renderedCount < lastCount) { observedFrame = renderedCount > 0; lastFrameAt = now; }
        lastCount = renderedCount;
        return observedFrame && now - lastFrameAt >= STALE_MS;
    }

    /** Returns the backoff in ms, or -1 after two retries within five minutes. */
    public long reserveRetry(long now) {
        while (!retries.isEmpty() && now - retries.peekFirst() >= WINDOW_MS) retries.removeFirst();
        if (retries.size() >= 2) return -1;
        retries.addLast(now);
        return retries.size() == 1 ? 1000 : 3000;
    }
}
