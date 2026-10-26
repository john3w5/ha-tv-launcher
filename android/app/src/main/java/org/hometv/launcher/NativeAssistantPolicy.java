package org.hometv.launcher;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** Fixed native command schema. Never accepts arbitrary intents, components or service names. */
public final class NativeAssistantPolicy {
    public static final Set<String> KEYS = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList("volume_up", "volume_down", "mute", "home", "back", "play_pause", "pause", "play")));
    private NativeAssistantPolicy() {}
    public static boolean authorize(String type, String appId, String key, String url, int fields) {
        if ("launch_app".equals(type)) return fields == 2 && NativeLaunchPolicy.isAllowedPackage(appId) && key == null && url == null;
        if ("key".equals(type)) return fields == 2 && key != null && KEYS.contains(key) && appId == null && url == null;
        return "prima_episode".equals(type) && fields == 3 && "cz.prima.tvapp".equals(appId) && key == null && validPrimaUrl(url);
    }
    public static boolean validPrimaUrl(String raw) {
        if (raw == null || raw.length() > 1000 || !raw.matches("https://www\\.iprima\\.cz/serialy/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+")) return false;
        try {
            URI uri = new URI(raw);
            return "https".equals(uri.getScheme()) && "www.iprima.cz".equals(uri.getRawAuthority()) &&
                uri.getPort() == -1 && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null && raw.equals(uri.toASCIIString());
        } catch (Exception invalid) { return false; }
    }
}
