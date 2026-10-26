package org.hometv.launcher;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;

/** Resolve nullable browser ICE identifiers to a real, non-null remote SDP media section before JNI. */
public final class NativeIceCandidatePolicy {
    private NativeIceCandidatePolicy() {}
    public static final class Target {
        public final String mid;
        public final int index;
        public final boolean video;
        private Target(String mid, int index, boolean video) { this.mid = mid; this.index = index; this.video = video; }
    }
    public static List<Target> mediaSections(String sdp) {
        if (sdp == null || sdp.length() > 60000 || !sdp.startsWith("v=0") || sdp.indexOf('\0') >= 0) return Collections.emptyList();
        List<Target> sections = new ArrayList<>();
        HashSet<String> mids = new HashSet<>();
        String mid = null; boolean video = false; boolean media = false;
        for (String line : sdp.split("\\r?\\n")) {
            if (line.startsWith("m=")) {
                if (media) {
                    if (mid == null || !mids.add(mid)) return Collections.emptyList();
                    sections.add(new Target(mid, sections.size(), video));
                }
                if (sections.size() >= 32) return Collections.emptyList();
                media = true; mid = null;
                video = line.matches("m=video\\s+.*");
            } else if (line.startsWith("a=mid:") && media) {
                String value = line.substring(6).trim();
                if (mid != null || !value.matches("[A-Za-z0-9_-]{1,64}")) return Collections.emptyList();
                mid = value;
            }
        }
        if (media) {
            if (mid == null || !mids.add(mid)) return Collections.emptyList();
            sections.add(new Target(mid, sections.size(), video));
        }
        return Collections.unmodifiableList(sections);
    }
    public static Target resolve(List<Target> sections, String suppliedMid, Integer suppliedIndex) {
        if (sections == null || sections.isEmpty() || sections.size() > 32) return null;
        if (suppliedMid != null && !suppliedMid.matches("[A-Za-z0-9_-]{1,64}")) return null;
        if (suppliedIndex != null && (suppliedIndex < 0 || suppliedIndex >= sections.size())) return null;
        Target selected = null;
        if (suppliedMid != null) {
            for (Target row : sections) if (row.mid.equals(suppliedMid)) { selected = row; break; }
            if (selected == null || suppliedIndex != null && selected.index != suppliedIndex) return null;
        } else if (suppliedIndex != null) selected = sections.get(suppliedIndex);
        else if (sections.size() == 1) selected = sections.get(0);
        return selected != null && selected.video && selected.mid != null && !selected.mid.isEmpty() ? selected : null;
    }
}
