package org.hometv.launcher;

public final class NativeCatalogPolicyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    public static void main(String[] args){
        NativeCatalogPolicy policy=new NativeCatalogPolicy();
        check(policy.schedule(false)==null,"No read from unhealthy or background page");
        var first=policy.schedule(true);
        check(first!=null,"One foreground catalog read");
        check(policy.schedule(true)==null,"No duplicate worker while pending");
        policy.cancel();
        check(!policy.complete(first,true),"Pause cancels old callback");
        var current=policy.schedule(true);
        check(!policy.complete(first,true),"Old callback cannot publish after resume");
        check(policy.complete(current,true),"Latest callback publishes");
        check(!policy.complete(current,true),"One result publishes once");
        var changedPage=policy.schedule(true);policy.cancel();
        check(!policy.complete(changedPage,true),"Navigation cancels old page snapshot");
        var lostFocus=policy.schedule(true);
        check(!policy.complete(lostFocus,false),"Eligibility checked again on UI thread");
        var resumed=policy.schedule(true);
        check(resumed!=null,"Discarded result allows a new foreground read");
        check(!policy.complete(null,true),"No invented snapshot");
        check(policy.complete(resumed,true),"Invalid old completion cannot cancel newer task");
        System.out.println("NativeCatalogPolicy: "+checks+" assertions passed.");
    }
}
