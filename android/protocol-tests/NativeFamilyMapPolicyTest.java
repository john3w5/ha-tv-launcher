package org.hometv.launcher;
public final class NativeFamilyMapPolicyTest {
    private static int checks;
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    public static void main(String[] args) {
        check(NativeFamilyMapPolicy.document(NativeFamilyMapPolicy.DOCUMENT), "Local Android asset document");
        check("family-map/index.html".equals(NativeFamilyMapPolicy.asset(NativeFamilyMapPolicy.DOCUMENT)), "Exact packaged document mapping");
        for (String name : new String[]{"leaflet.js", "leaflet.css", "family-map.js", "family-map.css", "images/marker-icon.png", "images/marker-shadow.png"})
            check(NativeFamilyMapPolicy.asset("https://appassets.androidplatform.net/assets/family-map/" + name) != null, "Only shipped resources load locally");
        check(NativeFamilyMapPolicy.tile("https://tile.openstreetmap.org/0/0/0.png"), "World tile boundary");
        check(NativeFamilyMapPolicy.tile("https://tile.openstreetmap.org/19/524287/524287.png"), "Highest permitted tile boundary");
        for (String invalid : new String[]{null, "", "file:///data/config.json", "content://private/config", "javascript:alert(1)",
            "http://home-tv.local:4317/api/dashboard", "https://home-tv.local:4317/api/dashboard", "https://www.google.com/maps",
            "https://tile.openstreetmap.org.evil.invalid/1/0/0.png", "http://tile.openstreetmap.org/1/0/0.png", "https://user:secret@tile.openstreetmap.org/1/0/0.png",
            "https://tile.openstreetmap.org:4317/1/0/0.png", "https://tile.openstreetmap.org/20/0/0.png", "https://tile.openstreetmap.org/1/2/0.png",
            "https://tile.openstreetmap.org/1/0/2.png", "https://tile.openstreetmap.org/1/-1/0.png", "https://tile.openstreetmap.org/1/0/0.png?nocache=1",
            "https://tile.openstreetmap.org/1/0/0.png#x", "https://appassets.androidplatform.net/assets/family-map/../../private/config.json",
            "https://appassets.androidplatform.net/assets/family-map/%2e%2e/index.html", "https://appassets.androidplatform.net/assets/family-map/unknown.js"}) {
            check(!NativeFamilyMapPolicy.tile(invalid), "No arbitrary host, path, query or tile bounds");
            check(NativeFamilyMapPolicy.asset(invalid) == null && !NativeFamilyMapPolicy.document(invalid), "No local secret or arbitrary asset navigation");
        }
        check(NativeFamilyMapPolicy.coordinates(0, 0), "Real zero position stays valid");
        check(NativeFamilyMapPolicy.coordinates(85.05112878, -180), "Web Mercator supported boundary");
        check(!NativeFamilyMapPolicy.coordinates(90, 0) && !NativeFamilyMapPolicy.coordinates(Double.NaN, 0) && !NativeFamilyMapPolicy.coordinates(0, 181), "No invented polar/invalid position");
        check(NativeFamilyMapPolicy.attribution("https://www.openstreetmap.org/copyright"), "Fixed attribution target");
        check(!NativeFamilyMapPolicy.attribution("https://evil.invalid/") && !NativeFamilyMapPolicy.attribution("https://www.openstreetmap.org/copyright?redirect=evil"), "No arbitrary external navigation");
        System.out.println("NativeFamilyMapPolicy: " + checks + " assertions passed.");
    }
}
