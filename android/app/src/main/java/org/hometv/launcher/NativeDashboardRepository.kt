package org.hometv.launcher

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** In-memory data only. Pairing stays in Android's existing persistent HttpOnly cookie jar. */
data class NativeSnapshot(
    val bootstrap: JSONObject,
    val dashboard: JSONObject?,
    val photos: JSONArray,
    val photosAvailable: Boolean = true,
)

/** Safe errors contain neither a server response body nor an address, cookie or underlying exception. */
class NativeDashboardError(val code: String, val status: Int = 0) : IOException(when (code) {
    "unauthorized" -> "Přehled vyžaduje spárování s domácím mostem."
    "forbidden" -> "Tato akce není pro tuto obrazovku povolená."
    "not_found" -> "Požadovaný údaj není dostupný."
    "too_large" -> "Odpověď překročila bezpečnou velikost."
    "busy" -> "Přehled právě zpracovává jiné požadavky."
    "timeout" -> "Domácí most neodpověděl včas."
    "unverified_result" -> "Výsledek odeslaného povelu není ověřený. Požadavek se automaticky neopakuje."
    "invalid_request" -> "Neplatný požadavek přehledu."
    "invalid_response" -> "Domácí most vrátil neplatnou odpověď."
    "redirect" -> "Přesměrování domácího mostu není povolené."
    "http_error" -> "Domácí most požadavek nepotvrdil."
    else -> "Spojení s domácím mostem není dostupné."
})

/**
 * A single bounded worker for fixed same-origin bridge APIs. No HA credentials, arbitrary
 * URLs, automatic POST retries, disk cache, broad app inventory, or device-side HA calls.
 * Call cancelPending() when the owning screen pauses; call close() when it is destroyed.
 */
class NativeDashboardRepository(
    dashboardUrl: String = BuildConfig.DASHBOARD_URL,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) : AutoCloseable {
    private val base = checkedOrigin(dashboardUrl)
    private val origin = base.toString().removeSuffix("/")
    private val lock = Any()
    private var generation = 0L
    private var closed = false
    private var activeConnection: HttpURLConnection? = null
    private var activeThread: Thread? = null
    private val worker = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue<Runnable>(8), { runnable -> Thread(runnable, "TV-dashboard-data").apply { isDaemon = true } })

    fun getBootstrap(callback: (Result<JSONObject>) -> Unit) =
        requestJson("GET", "/api/bootstrap", callback = callback)

    fun getDashboard(callback: (Result<JSONObject>) -> Unit) =
        requestJson("GET", "/api/dashboard", callback = callback)

    fun getPhotoList(callback: (Result<JSONArray>) -> Unit) {
        submit(callback) { ticket -> readJson("GET", "/api/photos", null, ticket).getJSONArray("photos") }
    }

    fun getProfileImage(callback: (Result<ByteArray>) -> Unit) =
        requestBytes("/api/profile/photo", callback)

    fun photo(id: String, callback: (Result<ByteArray>) -> Unit) =
        requestBytes("/api/photos/$id/file", callback)

    fun snapshot(id: String, quality: String = "smooth", callback: (Result<ByteArray>) -> Unit) =
        requestBytes("/api/cameras/$id/snapshot?quality=$quality", callback)

    fun post(path: String, body: JSONObject, callback: (Result<JSONObject>) -> Unit) =
        requestJson("POST", path, body, callback)

    /** GET /api/photos is normalized to {photos: JSONArray}; other JSON routes return objects. */
    fun requestJson(method: String, path: String, body: JSONObject? = null, callback: (Result<JSONObject>) -> Unit) {
        // Snapshot mutable JSONObject on the caller thread before the worker can observe later edits.
        val encoded = try {
            if (!jsonRoute(method, path) || (method == "GET" && body != null) || (method in setOf("POST", "PUT") && body == null))
                throw NativeDashboardError("invalid_request")
            body?.toString()?.toByteArray(StandardCharsets.UTF_8)?.also {
                if (it.size > MAX_POST_BYTES) throw NativeDashboardError("too_large")
            }
        } catch (error: Exception) {
            deliverFailure(callback, if (error is NativeDashboardError) error else NativeDashboardError("invalid_request"))
            return
        }
        submit(callback) { ticket ->
            try { readJson(method, path, encoded, ticket) }
            catch (error: Exception) {
                if (method in setOf("POST", "PUT") && (error is SocketTimeoutException || error is NativeDashboardError && error.code == "timeout"))
                    throw NativeDashboardError("unverified_result")
                throw error
            }
        }
    }

    /** Only profile/photo/vacuum/snapshot paths are accepted, never an arbitrary URL from JSON. */
    fun requestBytes(path: String, callback: (Result<ByteArray>) -> Unit) {
        if (!imageRoute(path)) { deliverFailure(callback, NativeDashboardError("invalid_request")); return }
        submit(callback) { ticket ->
            val response = exchange("GET", path, null, MAX_IMAGE_BYTES, ticket)
            if (!imageEnvelope(response.type, response.data)) throw NativeDashboardError("invalid_response")
            response.data
        }
    }

    /** One queued job; optional photo failure does not conceal a healthy household dashboard. */
    fun refresh(callback: (Result<NativeSnapshot>) -> Unit) {
        submit(callback) { ticket ->
            val bootstrap = readJson("GET", "/api/bootstrap", null, ticket)
            val authenticated = bootstrap.optBoolean("authenticated", false)
            val dashboard = if (authenticated || bootstrap.optString("mode") == "demo")
                readJson("GET", "/api/dashboard", null, ticket) else null
            var photosAvailable = true
            val photos = if (authenticated) try {
                readJson("GET", "/api/photos", null, ticket).getJSONArray("photos")
            } catch (_: Exception) { photosAvailable = false; JSONArray() } else JSONArray()
            checkCurrent(ticket)
            NativeSnapshot(bootstrap, dashboard, photos, photosAvailable)
        }
    }

    /** Cancels client work and queued callbacks; it cannot undo a command already accepted by the bridge/HA. */
    fun cancelPending() {
        val connection: HttpURLConnection?
        synchronized(lock) {
            generation++
            worker.queue.clear()
            activeThread?.interrupt()
            connection = activeConnection
        }
        connection?.disconnect()
    }

    override fun close() {
        synchronized(lock) { if (closed) return; closed = true }
        cancelPending()
        worker.shutdownNow()
    }

    private data class Response(val data: ByteArray, val type: String)

    private fun readJson(method: String, path: String, body: ByteArray?, ticket: Long): JSONObject {
        if (!jsonRoute(method, path)) throw NativeDashboardError("invalid_request")
        val response = exchange(method, path, body, MAX_JSON_BYTES, ticket)
        if (response.type != "application/json") throw NativeDashboardError("invalid_response")
        try {
            val decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val parser = JSONTokener(decoder.decode(ByteBuffer.wrap(response.data)).toString())
            val value = parser.nextValue()
            if (parser.nextClean() != '\u0000') throw NativeDashboardError("invalid_response")
            return if (path == "/api/photos" && value is JSONArray) JSONObject().put("photos", value)
                else value as? JSONObject ?: throw NativeDashboardError("invalid_response")
        } catch (_: Exception) { throw NativeDashboardError("invalid_response") }
    }

    private fun exchange(method: String, path: String, body: ByteArray?, limit: Int, ticket: Long): Response {
        checkCurrent(ticket)
        val target = base.resolve(path)
        val connection = target.toURL().openConnection() as HttpURLConnection
        val readBudget = readTimeoutMs(method, path)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(totalTimeoutMs(method, path).toLong())
        try {
            synchronized(lock) {
                checkCurrentLocked(ticket)
                activeConnection = connection
            }
            connection.apply {
                instanceFollowRedirects = false
                useCaches = false
                connectTimeout = 4000
                readTimeout = readBudget
                requestMethod = method
                setRequestProperty("Accept", if (limit == MAX_JSON_BYTES) "application/json" else "image/jpeg,image/png,image/webp")
                setRequestProperty("Accept-Encoding", "identity")
                setRequestProperty("User-Agent", "HomeTVNative/${BuildConfig.VERSION_NAME}")
                OverlayProtocol.sessionCookie(CookieManager.getInstance().getCookie(target.toString()))?.let {
                    setRequestProperty("Cookie", it)
                }
                if (method in setOf("POST", "PUT")) {
                    setRequestProperty("Origin", origin)
                    setRequestProperty("Content-Type", "application/json")
                    doOutput = true
                    setFixedLengthStreamingMode(body?.size ?: 0)
                    outputStream.use { it.write(body ?: ByteArray(0)) }
                }
            }
            checkCurrent(ticket)
            val status = connection.responseCode
            if (status !in 200..299) throw NativeDashboardError(when (status) {
                401 -> "unauthorized"; 403 -> "forbidden"; 404 -> "not_found"
                in 300..399 -> "redirect"; else -> "http_error"
            }, status)
            val type = connection.contentType.orEmpty().substringBefore(';').trim().lowercase()
            val declared = connection.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            if (declared > limit) throw NativeDashboardError("too_large")
            val data = connection.inputStream.use { input ->
                readBounded(input, limit) {
                    checkCurrent(ticket)
                    val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                    if (remaining <= 0) throw NativeDashboardError("timeout")
                    connection.readTimeout = minOf(readBudget.toLong(), remaining).coerceAtLeast(1).toInt()
                }
            }
            checkCurrent(ticket)
            // Only the two explicit authentication routes may modify our existing pairing cookie.
            if (method == "POST" && path in setOf("/api/pair", "/api/logout")) {
                val cookies = connection.headerFields.entries.filter { it.key?.equals("Set-Cookie", true) == true }
                    .flatMap { it.value.orEmpty() }
                for (cookie in cookies.take(4)) {
                    if (cookie.length <= 4096 && '\r' !in cookie && '\n' !in cookie && cookie.startsWith("tv_session=") &&
                        (OverlayProtocol.sessionCookie(cookie.substringBefore(';')) != null ||
                            path == "/api/logout" && cookie.substringBefore(';') == "tv_session=")) {
                        CookieManager.getInstance().setCookie(target.toString(), cookie)
                    }
                }
                CookieManager.getInstance().flush()
            }
            return Response(data, type)
        } finally {
            synchronized(lock) { if (activeConnection === connection) activeConnection = null }
            connection.disconnect()
        }
    }

    private fun <T> submit(callback: (Result<T>) -> Unit, action: (Long) -> T) {
        val ticket = synchronized(lock) { if (closed) return; generation }
        try {
            worker.execute {
                Thread.interrupted()
                synchronized(lock) { if (closed || ticket != generation) return@execute; activeThread = Thread.currentThread() }
                val result = try { Result.success(action(ticket)) }
                catch (error: Exception) { Result.failure<T>(when (error) {
                    is NativeDashboardError -> error
                    is SocketTimeoutException -> NativeDashboardError("timeout")
                    else -> NativeDashboardError("network")
                }) }
                finally { synchronized(lock) { if (activeThread === Thread.currentThread()) activeThread = null } }
                mainHandler.post { if (isCurrent(ticket)) callback(result) }
            }
        } catch (_: RejectedExecutionException) {
            mainHandler.post { if (isCurrent(ticket)) callback(Result.failure(NativeDashboardError("busy"))) }
        }
    }

    private fun <T> deliverFailure(callback: (Result<T>) -> Unit, error: NativeDashboardError) {
        val ticket = synchronized(lock) { if (closed) return; generation }
        mainHandler.post { if (isCurrent(ticket)) callback(Result.failure(error)) }
    }

    private fun isCurrent(ticket: Long) = synchronized(lock) { !closed && generation == ticket }
    private fun checkCurrent(ticket: Long) = synchronized(lock) { checkCurrentLocked(ticket) }
    private fun checkCurrentLocked(ticket: Long) {
        if (closed || generation != ticket || Thread.currentThread().isInterrupted) throw NativeDashboardError("network")
    }

    companion object {
        const val MAX_JSON_BYTES = 2 * 1024 * 1024
        const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
        const val MAX_POST_BYTES = 16 * 1024
        private val CAMERA = Regex("/api/cameras/[a-z0-9_-]{1,80}/(snapshot|stream)\\?quality=(smooth|hd)")
        private val PHOTO = Regex("/api/photos/[a-f0-9]{24}/file")
        private val GET_JSON = setOf("/api/bootstrap", "/api/dashboard", "/api/photos", "/api/notifications", "/api/notification-preferences", "/api/client-settings", "/api/timeline?limit=100", "/api/door/status")
        private val POST_JSON = setOf("/api/pair", "/api/logout", "/api/notification-preferences", "/api/night/prepare", "/api/night/commit", "/api/assistant", "/api/assistant/confirm", "/api/mobile/pairing", "/api/control", "/api/door/prepare", "/api/door/commit")

        @JvmStatic fun checkedOrigin(raw: String): URI {
            // Reuse the existing LAN/HTTPS policy without exposing an arbitrary URL API.
            val validated = try { OverlayProtocol.eventsUrl(raw) } catch (_: Exception) { throw IllegalArgumentException("Invalid dashboard origin") }
            return URI(validated.scheme, null, validated.host, validated.port, "/", null, null)
        }

        @JvmStatic fun jsonRoute(method: String, path: String): Boolean = when (method) {
            "GET" -> path in GET_JSON || CAMERA.matches(path) && path.contains("/stream?")
            "POST" -> path in POST_JSON
            "PUT" -> path == "/api/client-settings"
            else -> false
        }

        @JvmStatic fun imageRoute(path: String): Boolean = path in setOf("/api/profile/photo", "/api/vacuum/map") ||
            PHOTO.matches(path) || CAMERA.matches(path) && path.contains("/snapshot?")

        @JvmStatic fun readTimeoutMs(method: String, path: String): Int =
            if (method == "POST" && path in setOf("/api/assistant", "/api/assistant/confirm")) 60000 else 12000

        @JvmStatic fun totalTimeoutMs(method: String, path: String): Int =
            if (method == "POST" && path in setOf("/api/assistant", "/api/assistant/confirm")) 65000 else 16000

        @JvmStatic fun readBounded(input: InputStream, limit: Int, check: () -> Unit): ByteArray {
            require(limit in 1..MAX_IMAGE_BYTES)
            val output = ByteArrayOutputStream(minOf(8192, limit))
            val chunk = ByteArray(8192)
            while (true) {
                check()
                val size = input.read(chunk)
                if (size < 0) break
                if (size > limit - output.size()) throw NativeDashboardError("too_large")
                if (size > 0) output.write(chunk, 0, size)
            }
            check()
            return output.toByteArray()
        }

        @JvmStatic fun imageEnvelope(type: String, bytes: ByteArray): Boolean = when (type) {
            "image/jpeg" -> bytes.size >= 4 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() &&
                bytes[bytes.size - 2] == 0xff.toByte() && bytes.last() == 0xd9.toByte()
            "image/png" -> bytes.size >= 24 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 13, 10, 26, 10))
            "image/webp" -> bytes.size >= 12 && String(bytes, 0, 4, StandardCharsets.US_ASCII) == "RIFF" &&
                String(bytes, 8, 4, StandardCharsets.US_ASCII) == "WEBP"
            else -> false
        }
    }
}
