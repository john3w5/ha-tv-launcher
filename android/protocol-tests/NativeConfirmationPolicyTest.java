package org.hometv.launcher;

public final class NativeConfirmationPolicyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    public static void main(String[] args){
        var p=new NativeConfirmationPolicy();String id="abcdefghijklmnopqrstuvwxyzABCDEF";
        check(p.arm(id,1020000,1000000,50),"Exact server confirmation can arm for at most twenty seconds");
        check(p.click(51)==null&&p.count()==1,"First click cannot submit");
        check(p.click(52)==null&&p.count()==2,"Second click cannot submit");
        check(id.equals(p.click(53))&&p.count()==3,"Third explicit click consumes confirmation");
        check(p.click(54)==null,"Consumed token cannot replay");
        p.arm(id,1020000,1000000,50);p.click(100);p.clear();
        check(p.click(101)==null,"Close or pause revokes partial confirmation");
        check(!p.arm("bad",1020000,1000000,50),"No arbitrary confirmation id");
        check(!p.arm(id,1000000,1000000,50),"Already expired plan rejected");
        check(!p.arm(id,1020001,1000000,50),"Unbounded expiry rejected");
        check(!p.arm(id,1020000,1000000,Long.MAX_VALUE),"Monotonic deadline overflow rejected");
        check(p.arm(id,1000010,1000000,50),"Fresh short-lived plan");
        check(p.click(60)==null&&!p.armed(60),"Exact expiry boundary is closed");
        check(p.arm(id,1020000,1000000,50),"New preparation gets a new window");
        check(p.click(-1)==null,"Invalid elapsed clock is not authorized");
        System.out.println("NativeConfirmationPolicy: "+checks+" assertions passed.");
    }
}
