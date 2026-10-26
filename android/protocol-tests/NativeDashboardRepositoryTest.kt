package org.hometv.launcher

import java.io.ByteArrayInputStream
import java.io.InputStream

/** Pure protocol/bounds tests: no Android methods, server, HA, cookies or TV are contacted. */
object NativeDashboardRepositoryTest {
    private var checks = 0
    private fun check(value: Boolean, message: String) { checks++; if (!value) error(message) }
    private inline fun rejects(message: String, block: () -> Unit) {
        var rejected = false
        try { block() } catch (_: Exception) { rejected = true }
        check(rejected, message)
    }

    @JvmStatic fun main(args: Array<String>) {
        val p = NativeDashboardRepository
        for (path in listOf("/api/bootstrap", "/api/dashboard", "/api/photos", "/api/notifications", "/api/notification-preferences", "/api/client-settings", "/api/timeline?limit=100", "/api/door/status"))
            check(p.jsonRoute("GET", path), "Read-only bridge route $path")
        for (path in listOf("/api/pair", "/api/logout", "/api/notification-preferences", "/api/night/prepare", "/api/night/commit", "/api/assistant", "/api/assistant/confirm", "/api/mobile/pairing", "/api/control", "/api/door/prepare", "/api/door/commit"))
            check(p.jsonRoute("POST", path), "Fixed mutation route $path")
        check(p.jsonRoute("PUT", "/api/client-settings"), "Exact shared settings PUT")
        for (path in listOf("/api/control", "/api/client-settings?extra=1", "/api/timeline?limit=999", "/api/mobile/pairing"))
            check(!p.jsonRoute("PUT", path), "No arbitrary PUT expansion")
        for (path in listOf("/api/door/status", "/api/door/prepare", "/api/door/commit")) {
            for (method in listOf("PUT", "PATCH", "DELETE", "HEAD", "get", "post"))
                check(!p.jsonRoute(method, path), "Door routes have exact fixed methods")
            check(!p.imageRoute(path), "Door commands are never image resources")
        }
        check(!p.jsonRoute("POST", "/api/door/status"), "Door status cannot mutate")
        check(!p.jsonRoute("GET", "/api/door/prepare") && !p.jsonRoute("GET", "/api/door/commit"), "GET cannot prepare or commit door actions")
        for (path in listOf("/api/door/status?entityId=lock.other", "/api/door/status?cameraId=entrance", "/api/door/status#fragment",
            "/api/door/prepare?cameraId=entrance", "/api/door/commit?confirmationId=secret", "/api/door/open", "/api/door/unlock",
            "/api/door/entrance/open", "/api/door/../commit", "/api/%64oor/status", "/api/door//status", "/api/door/status/",
            "https://other.invalid/api/door/status", "//other.invalid/api/door/commit", "/api/services/lock/open")) {
            for (method in listOf("GET", "POST", "PUT")) check(!p.jsonRoute(method, path), "No arbitrary door target, alias, query or service route")
            check(!p.imageRoute(path), "No door action via image loader")
        }
        for (quality in listOf("smooth", "hd")) {
            check(p.jsonRoute("GET", "/api/cameras/entrance/stream?quality=$quality"), "Stream is a GET JSON route")
            check(p.imageRoute("/api/cameras/entrance/snapshot?quality=$quality"), "Snapshot is an image route")
            check(!p.jsonRoute("POST", "/api/cameras/entrance/stream?quality=$quality"), "No camera controls by POST")
        }
        val id = "a".repeat(24)
        for (path in listOf("/api/profile/photo", "/api/photos/$id/file", "/api/vacuum/map"))
            check(p.imageRoute(path), "Fixed private image route")
        val invalid = listOf("https://other.invalid/api/dashboard", "//other.invalid/api/dashboard", "/api/../dashboard",
            "/api/dashboard?token=secret", "/api/dashboard#fragment", "/api/%64ashboard", "/api/photos/short/file",
            "/api/photos/${"A".repeat(24)}/file", "/api/photos/$id/file?url=bad", "/api/cameras/../../snapshot?quality=smooth",
            "/api/cameras/a/snapshot?quality=hd&quality=smooth", "/api/cameras/a/stream?quality=bad",
            "/api/cameras/a/stream?quality=hd#fragment", "/api/cameras/a/stream?quality=hd&url=https://other.invalid",
            "/api/cameras/a/snapshot?quality=%68d", "/api/cameras/${"a".repeat(81)}/snapshot?quality=smooth",
            "/api/notify", "/api/tv/launch", "/api/events", "/api/photos/upload")
        for (path in invalid) {
            check(!p.jsonRoute("GET", path) && !p.jsonRoute("POST", path) && !p.imageRoute(path), "Reject path/protocol expansion")
        }
        check(!p.jsonRoute("DELETE", "/api/dashboard") && !p.jsonRoute("get", "/api/dashboard"), "Exact method boundary")
        for (path in listOf("/api/assistant", "/api/assistant/confirm")) {
            check(p.readTimeoutMs("POST", path) == 60000 && p.totalTimeoutMs("POST", path) == 65000, "Bounded model reply budget")
            check(p.readTimeoutMs("GET", path) == 12000, "Only the actual POST model endpoint gets an extended budget")
        }
        for (path in listOf("/api/dashboard", "/api/night/commit", "/api/pair", "/api/assistant?extra=1", "/api/assistant/other"))
            check(p.readTimeoutMs("POST", path) == 12000 && p.totalTimeoutMs("POST", path) == 16000, "Other requests keep the normal bound")
        check(NativeDashboardError("unverified_result").message.orEmpty().contains("není ověřený"), "Timeout cannot claim a command failed or completed")
        check(p.checkedOrigin("http://home-tv.local:4317/path").toString() == "http://home-tv.local:4317/", "Fixed origin excludes base path")
        check(p.checkedOrigin("https://example.invalid:443/").toString() == "https://example.invalid:443/", "HTTPS is permitted")
        for (base in listOf("http://example.invalid/", "https://user:secret@example.invalid/", "https://example.invalid/#fragment", "file:///tmp/a", "http://home-tv.local:0/"))
            rejects("Invalid origin") { p.checkedOrigin(base) }

        val bytes = ByteArray(8193) { (it % 251).toByte() }
        check(p.readBounded(ByteArrayInputStream(bytes), bytes.size) {}.contentEquals(bytes), "Exact limit succeeds across chunks")
        try { p.readBounded(ByteArrayInputStream(bytes), bytes.size - 1) {}; error("Oversize accepted") }
        catch (error: NativeDashboardError) { check(error.code == "too_large", "Chunked body is bounded before accumulating over the limit") }
        var checksOfCancellation = 0
        var readCount = 0
        val source = object : InputStream() {
            override fun read(): Int = 0
            override fun read(target: ByteArray, offset: Int, length: Int): Int { readCount++; target[offset] = 1; return 1 }
        }
        rejects("Cancellation interrupts a chunked read") {
            p.readBounded(source, 8192) { if (++checksOfCancellation == 3) throw IllegalStateException("cancelled") }
        }
        check(readCount == 2, "No reads after cancellation")
        rejects("No unbounded read limit") { p.readBounded(ByteArrayInputStream(bytes), p.MAX_IMAGE_BYTES + 1) {} }

        check(p.imageEnvelope("image/jpeg", byteArrayOf(-1, -40, -1, -39)), "JPEG envelope accepted")
        check(!p.imageEnvelope("image/jpeg", byteArrayOf(-1, -40, 0, 0)), "Truncated JPEG rejected")
        val png = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10) + ByteArray(16)
        check(p.imageEnvelope("image/png", png), "PNG envelope accepted")
        check(p.imageEnvelope("image/webp", "RIFF0000WEBP".toByteArray()), "WebP envelope accepted")
        check(!p.imageEnvelope("image/svg+xml", "<svg/>".toByteArray()), "SVG never reaches bitmap rendering")
        check(!p.imageEnvelope("image/png", "private response".toByteArray()), "MIME alone is insufficient")
        val safe = NativeDashboardError("network")
        check(safe.cause == null && !safe.message.orEmpty().contains("http"), "Errors expose no network cause or URL")
        println("NativeDashboardRepository: $checks assertions passed.")
    }
}
