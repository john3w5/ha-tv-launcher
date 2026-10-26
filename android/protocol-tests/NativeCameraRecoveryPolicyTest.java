package org.hometv.launcher;

public final class NativeCameraRecoveryPolicyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    public static void main(String[] args) {
        NativeCameraRecoveryPolicy policy = new NativeCameraRecoveryPolicy();
        policy.resetAll(0);
        check(!policy.observe(10000,0,true),"Initial cold stream is governed by its separate first-frame deadline");
        check(!policy.observe(10001,1,true),"First decoded frame starts progress timer");
        check(!policy.observe(15000,2,true),"Low FPS source producing a frame within six seconds is healthy");
        check(!policy.observe(20999,2,true),"No early restart before six-second boundary");
        check(policy.observe(21000,2,true),"Frozen frame is detected at six seconds");
        check(policy.reserveRetry(21000)==1000,"First recovery has one-second backoff");
        policy.resetProgress(22000);
        check(!policy.observe(30000,0,true),"Reconnect gets its own initial first-frame window");
        check(!policy.observe(30001,1,true),"New player frame starts new progress period");
        check(policy.observe(36001,1,true),"Second stall detected");
        check(policy.reserveRetry(36001)==3000,"Second recovery is backed off further");
        policy.resetProgress(40000);
        check(policy.reserveRetry(45000)==-1,"Progress reset cannot reset retry budget");
        check(policy.reserveRetry(320999)==-1,"Window is not expired early");
        check(policy.reserveRetry(321000)==3000,"Expired first reservation permits one retry while second remains");
        check(policy.reserveRetry(321001)==-1,"Budget remains bounded after sliding window purge");
        policy.resetAll(400000);
        check(policy.reserveRetry(400000)==1000,"New camera session starts fresh budget");
        policy.resetProgress(410000);
        check(!policy.observe(410001,10,true),"Frame observed before pause");
        check(!policy.observe(420000,10,false),"Not expected to play never triggers recovery");
        check(!policy.observe(420001,10,true),"Resume gets a grace period");
        check(!policy.observe(420100,11,true),"Progress resumes normally");
        check(!policy.observe(430000,0,true),"Decoder counter reset is not itself a freeze");
        check(!policy.observe(440000,0,true),"Reset player without first frame uses first-frame timeout");
        System.out.println("NativeCameraRecoveryPolicy: "+checks+" assertions passed.");
    }
}
