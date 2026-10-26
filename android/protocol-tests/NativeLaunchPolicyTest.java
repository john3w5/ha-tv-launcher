package org.hometv.launcher;

public final class NativeLaunchPolicyTest {
    private static int checks;
    private static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
    private static NativeLaunchPolicy.Action allow(String uri) {
        return NativeLaunchPolicy.authorize(uri, true, true, true, true, true, true, false);
    }
    public static void main(String[] args) {
        check(NativeLaunchPolicy.allowedPackages().size() == 12, "Exact twelve approved packages");
        for (String app : NativeLaunchPolicy.allowedPackages()) {
            var action = allow("hometv://launch?appId=" + app);
            check(action != null && action.kind == NativeLaunchPolicy.Kind.LAUNCH && app.equals(action.appId), "Approved exact package " + app);
        }
        check(allow("hometv://settings").kind == NativeLaunchPolicy.Kind.SETTINGS, "Retain settings");
        check(allow("hometv://voice").kind == NativeLaunchPolicy.Kind.VOICE, "Retain explicit voice");
        String[] rejected = {null, "", "hometv://launch", "hometv://launch?appId=", "hometv://launch/?appId=com.netflix.ninja",
            "hometv://launch?appId=com.netflix.ninja&appId=cz.prima.tvapp", "hometv://launch?appId=com.netflix.ninja&x=1",
            "hometv://launch?appId=com.netflix.ninja#x", "hometv://launch:1?appId=com.netflix.ninja",
            "hometv://user@launch?appId=com.netflix.ninja", "hometv://launch?appId=com.netflix.%6einja",
            "hometv://launch?appId=com.netflix.ninja%26x=1", "hometv://launch?appId=com.netflix.ninja%00",
            "hometv://launch?appId=com.netflix.ninja ", "hometv://launch?appId=com.netflix.ninja\n",
            "HOMETV://launch?appId=com.netflix.ninja", "hometv://launch?appid=com.netflix.ninja",
            "hometv://launch?appId=android", "hometv://launch?appId=org.hometv.launcher",
            "intent://com.netflix.ninja", "hometv://settings?x=1", "hometv://voice#x",
            "hometv://launch?appId=com.netflix.ninja/../../system", "hometv://launch?appId=com.netflix.ninja;reboot"};
        for (String uri : rejected) check(allow(uri) == null, "Reject malformed or unapproved URI");
        String uri = "hometv://launch?appId=com.netflix.ninja";
        for (int i = 0; i < 7; i++) {
            boolean[] b = {true,true,true,true,true,true,false};
            b[i] = !b[i];
            check(NativeLaunchPolicy.authorize(uri,b[0],b[1],b[2],b[3],b[4],b[5],b[6]) == null, "Every request gate is required " + i);
        }
        check(NativeLaunchPolicy.isLaunchable("com.netflix.ninja","com.netflix.ninja",true,true,true,true,true,true,true), "Enabled exported exact app");
        check(!NativeLaunchPolicy.isLaunchable("com.netflix.ninja","net.cme.voyo.cz.tvapp",true,true,true,true,true,true,true), "Never accept another resolved package");
        for (int i = 0; i < 7; i++) {
            boolean[] b = {true,true,true,true,true,true,true}; b[i] = false;
            check(!NativeLaunchPolicy.isLaunchable("com.netflix.ninja","com.netflix.ninja",b[0],b[1],b[2],b[3],b[4],b[5],b[6]), "Disabled/unexported/suspended/protected component cannot launch " + i);
        }
        check(!NativeLaunchPolicy.isLaunchable("android","android",true,true,true,true,true,true,true), "Package policy cannot be bypassed by resolver");
        try { NativeLaunchPolicy.allowedPackages().add("android"); throw new AssertionError("Mutable allowlist"); }
        catch (UnsupportedOperationException expected) { checks++; }
        System.out.println("NativeLaunchPolicy: " + checks + " assertions passed.");
    }
}
