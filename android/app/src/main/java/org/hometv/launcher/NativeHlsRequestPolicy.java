package org.hometv.launcher;

import java.net.URI;
import java.util.HashSet;
import java.util.Set;

/** Per-request camera URL guard, including the bounded LL-HLS reload query. */
public final class NativeHlsRequestPolicy {
    private NativeHlsRequestPolicy() {}

    public static URI requestUrl(String baseUrl, String value, boolean camera) {
        try {
            if (!camera) return NativeMediaPolicy.mediaUrl(baseUrl, value);
            URI input = new URI(value);
            if (input.getRawFragment() != null || input.getRawUserInfo() != null) return null;
            String query = input.getRawQuery();
            if (query != null && !validQuery(query)) return null;
            URI bare = new URI(input.getScheme(), input.getRawAuthority(), input.getRawPath(), null, null);
            URI checked = NativeMediaPolicy.streamUrl(baseUrl, bare.toString());
            if (checked == null) return null;
            return query == null ? checked : new URI(checked.toString() + "?" + query);
        } catch (Exception ignored) { return null; }
    }

    private static boolean validQuery(String query) {
        if (query.isEmpty() || query.length() > 128) return false;
        Set<String> seen = new HashSet<>();
        for (String item : query.split("&", -1)) {
            String[] pair = item.split("=", -1);
            if (pair.length != 2 || !seen.add(pair[0])) return false;
            if ("_HLS_skip".equals(pair[0])) {
                if (!"YES".equals(pair[1]) && !"v2".equals(pair[1])) return false;
            } else {
                long maximum;
                if ("_HLS_msn".equals(pair[0])) maximum = 2147483647L;
                else if ("_HLS_part".equals(pair[0])) maximum = 10000L;
                else return false;
                if (!pair[1].matches("[0-9]{1,10}")) return false;
                try { if (Long.parseLong(pair[1]) > maximum) return false; }
                catch (NumberFormatException ignored) { return false; }
            }
        }
        return true;
    }
}
