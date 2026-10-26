package org.hometv.launcher;

public final class NativeGoogleMapPolicyTest {
    private static int checks;
    private static void check(boolean ok, String message) { checks++; if (!ok) throw new AssertionError(message); }
    public static void main(String[] args) {
        check(NativeGoogleMapPolicy.coordinates(0, 0), "Zero coordinates remain valid");
        check(NativeGoogleMapPolicy.coordinates(-90, 180), "Valid coordinate boundaries");
        check(NativeGoogleMapPolicy.wrapperPage(NativeGoogleMapPolicy.WRAPPER_URL), "Owned wrapper has one exact HTTPS asset path");
        check(NativeGoogleMapPolicy.navigation(NativeGoogleMapPolicy.WRAPPER_URL), "The native main view can navigate to its owned asset");
        check(!NativeGoogleMapPolicy.resource(NativeGoogleMapPolicy.WRAPPER_URL), "Google subresources cannot request the private wrapper route");
        check(NativeGoogleMapPolicy.hostClass(NativeGoogleMapPolicy.WRAPPER_URL) == 10, "Owned wrapper has a fixed numeric diagnostic class");
        for (String invalidWrapper : new String[]{NativeGoogleMapPolicy.WRAPPER_URL + "?x=1", NativeGoogleMapPolicy.WRAPPER_URL + "#x", NativeGoogleMapPolicy.WRAPPER_URL + "/extra", NativeGoogleMapPolicy.WRAPPER_URL.replace("appassets.androidplatform.net", "www.google.com"), "https://appassets.androidplatform.net/private"}) {
            check(!NativeGoogleMapPolicy.wrapperPage(invalidWrapper), "Wrapper cannot expose another local path or origin");
        }
        String wrapper = NativeGoogleMapPolicy.mapWrapperHtml(NativeGoogleMapPolicy.mapUrl(0.000000, 0.000000, 14));
        check(wrapper.contains("<iframe") && wrapper.contains("&amp;output=embed") && wrapper.contains("referrerpolicy=\"strict-origin-when-cross-origin\""), "Google embed is genuinely framed on the app's own origin");
        check(wrapper.contains("content=\"width=960\"") && !wrapper.contains("initial-scale"), "Overview mode fits a real 960 CSS pixel iframe viewport without a density-locked scale");
        check(!wrapper.contains("maps/embed/v1") && !wrapper.contains("key="), "Wrapper does not create or borrow an API key");
        check(wrapper.contains("data-map-frame-loaded") && !wrapper.contains("map-ready"), "Iframe load is not called inner-map rendering proof");
        try { NativeGoogleMapPolicy.mapWrapperHtml("http://home-tv.local:4317/api/dashboard"); throw new AssertionError("Private frame target accepted"); }
        catch (IllegalArgumentException expected) { check(true, "Wrapper rejects local HA origin"); }
        check(NativeGoogleMapPolicy.embedDocument(NativeGoogleMapPolicy.mapUrl(0.000000, 0.000000, 14)), "Original Google embed HTML has document-level error handling");
        check(NativeGoogleMapPolicy.embedDocument("https://www.google.com/maps/embed?origin=mfe"), "Google's own redirect retains document-level error handling");
        for (String subresource : new String[]{"https://www.google.com/maps/api/js?output=embed", "https://maps.googleapis.com/maps/vt?output=embed", "https://www.google.com/maps/a.png", "https://www.google.com/maps?output=embed&output=embed", "https://www.google.com/maps?output=invalid", "https://www.google.com/maps/@?api=1", NativeGoogleMapPolicy.WRAPPER_URL, "http://home-tv.local/maps?output=embed"}) {
            check(!NativeGoogleMapPolicy.embedDocument(subresource), "A subresource or other origin cannot be mistaken for the embed HTML");
        }
        String androidAgent = "Mozilla/5.0 (Linux; Android 12; Television Build/TEST; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.7499.82 Mobile Safari/537.36";
        String desktopAgent = NativeGoogleMapPolicy.desktopUserAgent(androidAgent);
        check(NativeGoogleMapPolicy.userAgentFlags(androidAgent) == 7, "Default Android Mobile WebView diagnostic flags");
        check(desktopAgent.equals("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7499.82 Safari/537.36"), "Desktop site retains actual engine versions");
        check(NativeGoogleMapPolicy.userAgentFlags(desktopAgent) == 0, "Desktop site has no Android Mobile or WebView tokens");
        check(NativeGoogleMapPolicy.desktopUserAgent(desktopAgent).equals(desktopAgent), "Desktop-site construction is idempotent");
        check(!desktopAgent.contains("Television") && !desktopAgent.contains("Build/") && !desktopAgent.contains("Version/4.0"), "Device and WebView compatibility tokens are not forwarded");
        check(NativeGoogleMapPolicy.desktopUserAgent(androidAgent.replace("143.0.7499.82", "246.12.34567.890")).contains("Chrome/246.12.34567.890"), "Future installed Chrome is retained instead of pinned");
        check(NativeGoogleMapPolicy.userAgentFlags(androidAgent.replace(" Mobile", "")) == 5, "TV WebView need not include a Mobile token");
        check(NativeGoogleMapPolicy.userAgentFlags(androidAgent.replace("; wv", "")) == 7, "Android Version/4.0 remains a WebView hint");
        check(NativeGoogleMapPolicy.userAgentFlags(null) == 0 && NativeGoogleMapPolicy.userAgentFlags("unknown") == 0, "Unknown UA does not expose raw diagnostic text");
        for (String invalidAgent : new String[]{null, "", "x".repeat(2049), androidAgent + "\r\nHeader: value", androidAgent + "\u0000", androidAgent + "é",
                androidAgent.replace("Chrome/143.0.7499.82", "Firefox/143.0"), androidAgent.replace("AppleWebKit/537.36", "AppleWebKit/unknown"),
                androidAgent.replace("Safari/537.36", "Safari/unknown"), androidAgent + " Chrome/144.0.0.0", androidAgent + " AppleWebKit/537.37",
                androidAgent.replace("143.0.7499.82", "143.0.a.82"), androidAgent.replace("143.0.7499.82", "143.0.7499.82suffix")}) {
            check(NativeGoogleMapPolicy.desktopUserAgent(invalidAgent) == null, "Malformed or unknown engine leaves the actual default untouched");
        }
        for (double invalid : new double[]{Double.NaN, Double.POSITIVE_INFINITY, -91, 91}) check(!NativeGoogleMapPolicy.coordinates(invalid, 0), "Reject invalid latitude");
        check(!NativeGoogleMapPolicy.coordinates(0, 181), "Reject invalid longitude");
        String generated = NativeGoogleMapPolicy.mapUrl(0.000000, 0.000000, 14);
        check(generated.equals("https://www.google.com/maps?q=0.000000,0.000000&z=14&hl=cs&output=embed"), "Selected map uses numeric coordinates and native language only");
        check(NativeGoogleMapPolicy.navigation(generated) && NativeGoogleMapPolicy.resource(generated), "Generated map is allowed");
        check(NativeGoogleMapPolicy.mapUrl(0, 0, 100).contains("z=19"), "Zoom is bounded");
        check(NativeGoogleMapPolicy.resource("https://maps.gstatic.com/maps-api-v3/api/js/module.js"), "Google map resources are allowed");
        check(NativeGoogleMapPolicy.resource("https://maps.googleapis.com/maps/vt?x=1&y=2&z=3"), "Google map tiles are allowed");
        String normal = NativeGoogleMapPolicy.standardMapUrl(0.000000, 0.000000, 14);
        check(normal.equals("https://www.google.com/maps/@?api=1&map_action=map&center=0.000000%2C0.000000&zoom=14&basemap=roadmap&hl=cs"), "Fallback uses the documented keyless Maps URL");
        check(NativeGoogleMapPolicy.navigation(normal) && NativeGoogleMapPolicy.resource(normal), "Fallback is allowed inside the isolated map");
        check(NativeGoogleMapPolicy.referrer(generated, normal).equals(generated), "Keep the real Google Maps page referrer");
        check(NativeGoogleMapPolicy.referrer("http://home-tv.local:4317/private?token=x", generated).equals(generated), "Never forward a private referrer");
        check(NativeGoogleMapPolicy.referrer("https://www.google.com/", generated).equals(generated), "The Google root is not the embed referrer");
        check(NativeGoogleMapPolicy.referrer(null, null) == null, "Do not fabricate a referrer");
        check(NativeGoogleMapPolicy.postResource("https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo"), "Permit Google's own map RPC");
        check(NativeGoogleMapPolicy.postResource("https://www.google.com/maps/api/js/ApplicationService.GetEntityDetails"), "Permit Google's embed details RPC");
        check(!NativeGoogleMapPolicy.postResource("https://maps.gstatic.com/static/script.js"), "Static resources cannot accept POST");
        String rpc = "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo";
        check(NativeGoogleMapPolicy.preflightResource(rpc), "Allowed Maps JSON RPC can use a browser-managed CORS preflight");
        check(NativeGoogleMapPolicy.blockedReason(rpc, "OPTIONS", false) == 0, "Allowed preflight has a numeric success category");
        for (String deniedPreflight : new String[]{"https://maps.googleapis.com/maps/vt", "https://maps.gstatic.com/static/script.js",
                "https://www.google.com/maps/embed", "https://www.google.com/maps/$rpc/other", "https://consent.google.com/save",
                "https://accounts.google.com/$rpc/other", "https://maps.googleapis.com.evil.invalid/$rpc/other", "https://maps.googleapis.com:4317/$rpc/other",
                "http://maps.googleapis.com/$rpc/other", "https://maps.googleapis.com/$rpc", "https://ogads-pa.clients6.google.com/$rpc/other", "http://home-tv.local:4317/api/dashboard"}) {
            check(!NativeGoogleMapPolicy.preflightResource(deniedPreflight), "Preflight cannot extend the Maps POST host/path allowlist");
        }
        check(NativeGoogleMapPolicy.blockedReason(rpc, "PUT", false) == 4 && NativeGoogleMapPolicy.blockedReason(rpc, "DELETE", false) == 4, "Other mutation methods stay blocked");

        check(NativeGoogleMapPolicy.samePage(generated, generated.replace(",", "%2C")), "Browser query encoding identifies the same page");
        check(!NativeGoogleMapPolicy.samePage(normal, generated), "A late embed result cannot alter the fallback page");
        check(!NativeGoogleMapPolicy.samePage(generated, NativeGoogleMapPolicy.mapUrl(1, 1, 14)), "A former person's map cannot change the current map state");
        check(!NativeGoogleMapPolicy.samePage(null, generated) && !NativeGoogleMapPolicy.samePage(generated, null), "Closed pages have no active callbacks");
        for (String denied : new String[]{null, "", "file:///data/config.json", "content://private/", "javascript:alert(1)", "http://www.google.com/maps", "https://www.google.com.evil.invalid/maps", "https://user:password@www.google.com/maps", "https://accounts.google.com/ServiceLogin", "https://www.google.com:4317/maps", "http://home-tv.local:4317/api/dashboard", "https://www.google.com/gen_204", "https://www.google.com/ServiceLogin"}) {
            check(!NativeGoogleMapPolicy.resource(denied), "No private origin, insecure resource or login");
            check(!NativeGoogleMapPolicy.navigation(denied), "No external navigation");
            check(!NativeGoogleMapPolicy.postResource(denied), "No private or login POST");
        }
        check(!NativeGoogleMapPolicy.navigation("https://maps.gstatic.com/maps-api-v3/api/js/module.js"), "A resource cannot become a main page");
        String consent = "https://consent.google.com/m?continue=" + java.net.URLEncoder.encode(generated, java.nio.charset.StandardCharsets.UTF_8) + "&hl=cs";
        check(NativeGoogleMapPolicy.navigation(consent), "Allow Google's explicit Maps consent flow");
        check(NativeGoogleMapPolicy.resource(consent) && NativeGoogleMapPolicy.consentPage(consent), "The Maps consent document loads natively");
        check(NativeGoogleMapPolicy.consentPage(consent.replace("/m?", "/ml?")), "Allow Google's alternate visible consent document");
        check(NativeGoogleMapPolicy.samePage(consent, consent), "Current consent callbacks remain valid");
        check(!NativeGoogleMapPolicy.samePage(consent, generated), "Late consent cannot overwrite the resumed Maps page");
        for (String continuation : new String[]{"https://www.google.com/", "https://accounts.google.com/ServiceLogin", "https://www.google.com.evil.invalid/maps", "http://home-tv.local:4317/api/dashboard", "javascript:alert(1)", consent}) {
            String denied = "https://consent.google.com/m?continue=" + java.net.URLEncoder.encode(continuation, java.nio.charset.StandardCharsets.UTF_8);
            check(!NativeGoogleMapPolicy.consentPage(denied), "Consent only continues directly to Google Maps");
            check(!NativeGoogleMapPolicy.navigation(denied) && !NativeGoogleMapPolicy.resource(denied), "Consent cannot become an open navigation redirect");
        }
        for (String denied : new String[]{"https://consent.google.com/m", consent + "&continue=" + java.net.URLEncoder.encode(normal, java.nio.charset.StandardCharsets.UTF_8), consent.replace("/m?", "/save?"), consent.replace("consent.google.com", "consent.google.com.evil.invalid"), "https://consent.google.com/m?continue=%invalid"}) {
            check(!NativeGoogleMapPolicy.consentPage(denied), "Reject malformed or ambiguous consent continuation");
        }
        check(NativeGoogleMapPolicy.consentPostResource("https://consent.google.com/save"), "Visible Google consent can submit Google's exact save endpoint");
        for (String denied : new String[]{"http://consent.google.com/save", "https://consent.google.com/save/more", "https://accounts.google.com/save", "https://consent.google.com:4317/save", "https://www.google.com/ServiceLogin", "http://home-tv.local:4317/api/dashboard"}) {
            check(!NativeGoogleMapPolicy.consentPostResource(denied), "Consent POST cannot reach another origin or path");
        }
        check(!NativeGoogleMapPolicy.postResource("https://consent.google.com/save"), "Normal map mode cannot submit consent");
        check(NativeGoogleMapPolicy.hostClass(generated) == 1 && NativeGoogleMapPolicy.hostClass(consent) == 2, "Known Google document diagnostics are numeric");
        check(NativeGoogleMapPolicy.hostClass("https://accounts.google.com/ServiceLogin") == 3, "Blocked sign-in diagnosis is categorical");
        check(NativeGoogleMapPolicy.hostClass("https://maps.gstatic.com/static.js") == 4 && NativeGoogleMapPolicy.hostClass("https://maps.googleapis.com/maps/vt") == 5, "Known Google resource diagnostics are numeric");
        check(NativeGoogleMapPolicy.hostClass("http://home-tv.local:4317/api/dashboard?token=secret") == 0, "Private URLs yield no identifying diagnostic");
        check(NativeGoogleMapPolicy.googleErrorCode(null) == 0 && NativeGoogleMapPolicy.googleErrorCode("arbitrary private data") == 0, "Unknown diagnostic text is discarded");
        String[] errors = {"RefererNotAllowedMapError", "MissingKeyMapError", "InvalidKeyMapError", "ApiNotActivatedMapError", "ApiTargetBlockedMapError", "DeletedApiProjectMapError", "ExpiredKeyMapError", "OverQuotaMapError", "BillingNotEnabledMapError"};
        for (int i = 0; i < errors.length; i++) check(NativeGoogleMapPolicy.googleErrorCode("Google Maps JavaScript API error: " + errors[i] + " ignored-private-tail") == i + 1, "Public Google errors yield a fixed numeric category");
        System.out.println("NativeGoogleMapPolicy: " + checks + " assertions passed.");
    }
}
