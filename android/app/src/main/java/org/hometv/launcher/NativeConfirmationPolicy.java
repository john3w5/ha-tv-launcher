package org.hometv.launcher;

/** Explicit three-click, monotonic, one-use confirmation. No physical action is performed here. */
public final class NativeConfirmationPolicy {
    private String id;
    private long deadline;
    private int count;
    public synchronized boolean arm(String confirmationId,long expiresWall,long nowWall,long nowElapsed) {
        clear();
        long remaining;
        try { remaining=Math.subtractExact(expiresWall,nowWall); } catch(ArithmeticException invalid) { return false; }
        if(confirmationId==null||!confirmationId.matches("[A-Za-z0-9_-]{32}")||remaining<=0||remaining>20000||nowElapsed<0||nowElapsed>Long.MAX_VALUE-remaining)return false;
        id=confirmationId;deadline=nowElapsed+remaining;return true;
    }
    public synchronized boolean armed(long elapsed){return id!=null&&elapsed>=0&&elapsed<deadline;}
    public synchronized int count(){return count;}
    public synchronized String click(long elapsed) {
        if(!armed(elapsed)){clear();return null;}
        count++;
        if(count<3)return null;
        String token=id;id=null;return token;
    }
    public synchronized void clear(){id=null;deadline=0;count=0;}
}
