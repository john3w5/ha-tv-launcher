package org.hometv.launcher;

public final class NativeAssistantPolicyTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    public static void main(String[] args) {
        check(NativeAssistantPolicy.authorize("launch_app", "com.netflix.ninja", null, null, 2));
        check(!NativeAssistantPolicy.authorize("launch_app", "android.settings", null, null, 2));
        check(!NativeAssistantPolicy.authorize("launch_app", "com.netflix.ninja", null, null, 3));
        check(NativeAssistantPolicy.authorize("key", null, "volume_up", null, 2));
        check(!NativeAssistantPolicy.authorize("key", null, "power", null, 2));
        check(!NativeAssistantPolicy.authorize("key", "com.netflix.ninja", "home", null, 3));
        String valid = "https://www.iprima.cz/serialy/example-series/2-serie/1-epizoda";
        check(NativeAssistantPolicy.authorize("prima_episode", "cz.prima.tvapp", null, valid, 3));
        for (String bad : new String[] {"intent://evil", "http://www.iprima.cz/serialy/example-series/2-serie/1-epizoda", valid + "?x=1", valid + "#x", valid.replace("www.iprima.cz", "www.iprima.cz.evil.test"), valid.replace("www.iprima.cz", "user@www.iprima.cz"), valid.replace("www.iprima.cz", "www.iprima.cz:443"), valid.replace("1-epizoda", "%31-epizoda")}) check(!NativeAssistantPolicy.validPrimaUrl(bad));
        check(!NativeAssistantPolicy.authorize("prima_episode", "com.netflix.ninja", null, valid, 3));
        check(!NativeAssistantPolicy.authorize("raw_service", null, null, null, 1));
        System.out.println("NativeAssistantPolicy: " + checks + " checks passed");
    }
}
