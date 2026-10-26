package org.hometv.launcher

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Errors never contain SDP, ICE, an address, a cookie, a response body or a nested exception. */
class NativeWebRtcError(val code: String, val status: Int = 0) : IOException(when (code) {
    "unauthorized" -> "Přímý přenos vyžaduje připojení k domácnosti."
    "invalid_request" -> "Přímý přenos nelze připravit."
    "timeout" -> "Přímý přenos neodpověděl včas."
    else -> "Přímý přenos byl přerušen."
})

/** Two bounded workers: one SSE reader and one serialized signalling/cleanup worker. */
class NativeWebRtcTransport(
    baseUrl: String = BuildConfig.DASHBOARD_URL,
    private val onCandidate: (JSONObject) -> Unit,
    private val onClosed: (String) -> Unit,
) {
    data class Answer(val sdp: String, val candidates: List<JSONObject>)
    private data class Session(val ticket: Long, val id: String, val cookie: String)
    private class Operation(val cleanup: Boolean, val action: () -> Unit) : Runnable { override fun run() = action() }
    private val base = NativeWebRtcPolicy.origin(baseUrl)
    private val origin = base.toString().removeSuffix("/")
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var generation = 0L
    private var destroyed = false
    private var active: Session? = null
    private var opening = false
    private var eventsStarted = false
    private var candidateDrain = false
    private var sentCandidates = 0
    private var remoteCandidates = 0
    private val queuedCandidates = ArrayDeque<JSONObject>()
    private val connections = HashMap<HttpURLConnection, Boolean>() // true = cleanup; never cancelled with a session generation.
    private var eventConnection: HttpURLConnection? = null
    private var eventThread: Thread? = null
    private val operationQueue = LinkedBlockingDeque<Runnable>(32)
    private val operations = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, operationQueue,
        { work -> Thread(work, "TV-RTC-signalling").apply { isDaemon = true } })
    private val events = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, LinkedBlockingDeque<Runnable>(1),
        { work -> Thread(work, "TV-RTC-events").apply { isDaemon = true } })

    init { operations.prestartCoreThread() }

    fun open(cameraId: String, quality: String, offer: String, callback: (Result<Answer>) -> Unit) {
        val ticket = stopSession() ?: return
        synchronized(lock) { if (!currentLocked(ticket)) return; opening = true }
        val body: ByteArray
        val cookie: String
        try {
            if (!NativeWebRtcPolicy.cameraId(cameraId) || !NativeWebRtcPolicy.quality(quality) || !NativeWebRtcPolicy.sdp(offer)) throw NativeWebRtcError("invalid_request")
            body = JSONObject().put("offer", offer).put("quality", quality).toString().toByteArray(StandardCharsets.UTF_8)
            if (body.size > 65536) throw NativeWebRtcError("invalid_request")
            cookie = OverlayProtocol.sessionCookie(CookieManager.getInstance().getCookie(base.toString())) ?: throw NativeWebRtcError("unauthorized")
        } catch (error: Exception) {
            synchronized(lock) { if (currentLocked(ticket)) opening = false }
            deliver(ticket) { callback(Result.failure(safe(error))) }; return
        }
        submit(ticket) {
            try {
                val response = exchange("POST", NativeWebRtcPolicy.offer(base, cameraId), cookie, body, ticket, 20000)
                val id = response.optString("sessionId")
                if (!NativeWebRtcPolicy.sessionId(id)) throw NativeWebRtcError("invalid_response")
                val session = Session(ticket, id, cookie)
                try {
                    val answer = response.opt("answer") as? String ?: throw NativeWebRtcError("invalid_response")
                    if (!NativeWebRtcPolicy.sdp(answer)) throw NativeWebRtcError("invalid_response")
                    val initial = response.optJSONArray("candidates") ?: throw NativeWebRtcError("invalid_response")
                    if (initial.length() > 128) throw NativeWebRtcError("limit")
                    val candidates = (0 until initial.length()).map { sanitizeCandidate(initial.optJSONObject(it) ?: throw NativeWebRtcError("invalid_response")) }
                    val accepted = synchronized(lock) {
                        if (!currentLocked(ticket)) false else { active = session; opening = false; remoteCandidates = candidates.size; true }
                    }
                    if (!accepted) { deleteSession(session); return@submit }
                    deliver(ticket) { callback(Result.success(Answer(answer, candidates))); scheduleCandidates(session) }
                } catch (error: Exception) { deleteSession(session); throw error }
            } catch (error: Exception) {
                val failedCurrent = synchronized(lock) {
                    if (!currentLocked(ticket)) false else { opening = false; true }
                }
                if (failedCurrent) {
                    deliver(ticket) { callback(Result.failure(safe(error))) }
                }
            }
        }
    }

    /** Call after the controller has successfully set its remote description and initial ICE. */
    fun startEvents() {
        val session = synchronized(lock) {
            val value = active ?: return
            if (destroyed || eventsStarted) return
            eventsStarted = true; value
        }
        try { events.execute { readEventLoop(session) } }
        catch (_: RejectedExecutionException) { failSession(session.ticket, "busy") }
    }

    fun sendCandidate(candidate: JSONObject) {
        val ticket = synchronized(lock) { if (destroyed) return; generation }
        val sanitized = try { sanitizeCandidate(candidate) } catch (_: Exception) {
            failSession(ticket, "invalid_response"); return
        }
        var limitReached = false
        val session = synchronized(lock) {
            if (!currentLocked(ticket) || (!opening && active == null)) return
            if (queuedCandidates.size + sentCandidates >= 128) { limitReached = true; null }
            else { queuedCandidates.addLast(sanitized); active }
        }
        if (limitReached) { failSession(ticket, "limit"); return }
        session?.let(::scheduleCandidates)
    }

    private fun scheduleCandidates(session: Session) {
        synchronized(lock) {
            if (!currentLocked(session.ticket) || active !== session || candidateDrain || queuedCandidates.isEmpty()) return
            candidateDrain = true
        }
        submit(session.ticket) {
            try {
                while (current(session.ticket)) {
                    val candidate = synchronized(lock) { if (active !== session || queuedCandidates.isEmpty()) null else queuedCandidates.removeFirst().also { sentCandidates++ } } ?: break
                    exchange("POST", NativeWebRtcPolicy.session(base, session.id, "candidate"), session.cookie,
                        JSONObject().put("candidate", candidate).toString().toByteArray(StandardCharsets.UTF_8), session.ticket, 8000)
                }
            } catch (error: Exception) { failSession(session.ticket, safe(error).code) }
            finally {
                val again = synchronized(lock) { if (currentLocked(session.ticket)) { candidateDrain = false; queuedCandidates.isNotEmpty() } else false }
                if (again) scheduleCandidates(session)
            }
        }
    }

    private fun readEventLoop(session: Session) {
        Thread.interrupted() // A closed preceding session may have interrupted this reused reader thread.
        var retries = 0
        var lastId: Int? = null
        synchronized(lock) { if (!currentLocked(session.ticket)) return; eventThread = Thread.currentThread() }
        try {
            while (current(session.ticket)) {
                var connection: HttpURLConnection? = null
                try {
                    val stream = connect("GET", NativeWebRtcPolicy.session(base, session.id, "events"), session.cookie, null, session.ticket, 25000)
                    connection = stream
                    synchronized(lock) { if (!currentLocked(session.ticket)) return; eventConnection = stream }
                    lastId?.let { stream.setRequestProperty("Last-Event-ID", it.toString()) }
                    checkStatus(stream)
                    if (stream.contentType.orEmpty().substringBefore(';').trim().lowercase() != "text/event-stream") throw NativeWebRtcError("invalid_response")
                    readEvents(stream.inputStream, session) { id, type, json ->
                        if (id != null) { if (lastId != null && id <= lastId!!) return@readEvents; lastId = id }
                        when (type) {
                            "candidate" -> {
                                val candidate = sanitizeCandidate(json.optJSONObject("candidate") ?: throw NativeWebRtcError("invalid_response"))
                                synchronized(lock) { if (!currentLocked(session.ticket)) return@readEvents; remoteCandidates++; if (remoteCandidates > 128) throw NativeWebRtcError("limit") }
                                deliver(session.ticket) { onCandidate(candidate) }
                            }
                            "closed" -> {
                                val reason = json.optString("reason").takeIf { it in setOf("closed", "ended", "expired", "disconnected", "failed") } ?: "remote_closed"
                                failSession(session.ticket, reason)
                            }
                        }
                    }
                    if (current(session.ticket)) throw NativeWebRtcError("network")
                } catch (error: Exception) {
                    if (!current(session.ticket)) return
                    val safe = safe(error)
                    if (++retries > 2 || safe.code in setOf("unauthorized", "invalid_response", "limit", "redirect")) { failSession(session.ticket, safe.code); return }
                } finally {
                    connection?.let { release(it) }
                    synchronized(lock) { if (eventConnection === connection) eventConnection = null }
                }
                try { Thread.sleep(retries * 500L) } catch (_: InterruptedException) { return }
            }
        } finally { synchronized(lock) { if (eventThread === Thread.currentThread()) eventThread = null } }
    }

    private fun readEvents(input: InputStream, session: Session, consume: (Int?, String, JSONObject) -> Unit) {
        val decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val reader = BufferedReader(InputStreamReader(input, decoder), 4096)
        var type = "message"; var id: Int? = null; val data = StringBuilder()
        while (current(session.ticket) && !Thread.currentThread().isInterrupted) {
            val line = readLine(reader) ?: return
            if (line.isEmpty()) {
                if (data.isNotEmpty() && type in setOf("candidate", "closed")) consume(id, type, parseJson(data.toString()))
                type = "message"; id = null; data.setLength(0); continue
            }
            if (line.startsWith(':')) continue
            val separator = line.indexOf(':'); val field = if (separator < 0) line else line.substring(0, separator)
            val value = if (separator < 0) "" else line.substring(separator + 1).removePrefix(" ")
            when (field) {
                "event" -> { if (value.length > 64) throw NativeWebRtcError("invalid_response"); type = value }
                "id" -> { id = value.toIntOrNull()?.takeIf { it in 1..128 } ?: throw NativeWebRtcError("invalid_response") }
                "data" -> { if (data.length + value.length + 1 > 16384) throw NativeWebRtcError("limit"); if (data.isNotEmpty()) data.append('\n'); data.append(value) }
            }
        }
    }

    private fun readLine(reader: BufferedReader): String? {
        val line = StringBuilder()
        while (true) {
            val char = reader.read(); if (char < 0) return null // Unterminated SSE is not dispatched.
            if (char == 10) return line.toString()
            if (char == 13) { reader.mark(1); if (reader.read() != 10) reader.reset(); return line.toString() }
            if (line.length >= 16384) throw NativeWebRtcError("limit")
            line.append(char.toChar())
        }
    }

    private fun sanitizeCandidate(input: JSONObject): JSONObject {
        val allowed = setOf("candidate", "sdpMid", "sdpMLineIndex", "usernameFragment")
        if (input.keys().asSequence().any { it !in allowed }) throw NativeWebRtcError("invalid_response")
        val candidate = input.opt("candidate") as? String ?: throw NativeWebRtcError("invalid_response")
        if (!NativeWebRtcPolicy.candidate(candidate)) throw NativeWebRtcError("invalid_response")
        val output = JSONObject().put("candidate", candidate)
        if (!input.isNull("sdpMid")) {
            val mid = input.opt("sdpMid") as? String ?: throw NativeWebRtcError("invalid_response")
            if (!NativeWebRtcPolicy.mid(mid)) throw NativeWebRtcError("invalid_response"); output.put("sdpMid", mid)
        }
        if (!input.isNull("sdpMLineIndex")) {
            val line = input.opt("sdpMLineIndex") as? Number ?: throw NativeWebRtcError("invalid_response")
            if (!NativeWebRtcPolicy.line(line.toDouble())) throw NativeWebRtcError("invalid_response"); output.put("sdpMLineIndex", line.toInt())
        }
        if (!input.isNull("usernameFragment")) {
            val fragment = input.opt("usernameFragment") as? String ?: throw NativeWebRtcError("invalid_response")
            if (!NativeWebRtcPolicy.fragment(fragment)) throw NativeWebRtcError("invalid_response"); output.put("usernameFragment", fragment)
        }
        return output
    }

    private fun exchange(method: String, target: URI, cookie: String, body: ByteArray?, ticket: Long?, timeout: Int): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout.toLong() + 4000)
        val connection = connect(method, target, cookie, body, ticket, timeout)
        try {
            checkStatus(connection)
            if (connection.contentType.orEmpty().substringBefore(';').trim().lowercase() != "application/json") throw NativeWebRtcError("invalid_response")
            if ((connection.getHeaderField("Content-Length")?.toLongOrNull() ?: 0) > 262144) throw NativeWebRtcError("limit")
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream(); val block = ByteArray(8192)
                while (true) {
                    val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                    if (remaining <= 0) throw NativeWebRtcError("timeout")
                    connection.readTimeout = minOf(timeout.toLong(), remaining).coerceAtLeast(1).toInt()
                    val count = input.read(block); if (count < 0) break
                    if (output.size() + count > 262144) throw NativeWebRtcError("limit"); output.write(block, 0, count)
                }
                output.toByteArray()
            }
            val decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            return parseJson(decoder.decode(ByteBuffer.wrap(bytes)).toString())
        } finally { release(connection) }
    }

    private fun connect(method: String, target: URI, cookie: String, body: ByteArray?, ticket: Long?, timeout: Int): HttpURLConnection {
        if (!NativeMediaPolicy.sameOrigin(base.toString(), target) || target.rawQuery != null || target.rawFragment != null || target.rawUserInfo != null ||
            !target.path.matches(Regex("/api/(?:cameras/[a-z0-9_-]{1,80}/webrtc|webrtc/[A-Za-z0-9_-]{32}(?:/(?:events|candidate))?)"))) throw NativeWebRtcError("invalid_request")
        val connection = target.toURL().openConnection() as HttpURLConnection
        try {
            synchronized(lock) { if (ticket != null && !currentLocked(ticket)) throw NativeWebRtcError("cancelled"); connections[connection] = ticket == null }
            connection.apply {
                instanceFollowRedirects = false; useCaches = false; connectTimeout = 4000; readTimeout = timeout; requestMethod = method
                setRequestProperty("Accept", if (target.path.endsWith("/events")) "text/event-stream" else "application/json")
                setRequestProperty("Accept-Encoding", "identity"); setRequestProperty("Cookie", cookie)
                setRequestProperty("User-Agent", "HomeTVNative/${BuildConfig.VERSION_NAME}")
                if (method == "POST" || method == "DELETE") setRequestProperty("Origin", origin)
                if (method == "POST") {
                    if (body == null || body.size > if (target.path.endsWith("/candidate")) 16384 else 65536) throw NativeWebRtcError("invalid_request")
                    setRequestProperty("Content-Type", "application/json"); doOutput = true; setFixedLengthStreamingMode(body.size)
                    outputStream.use { it.write(body) }
                }
            }
            return connection
        } catch (error: Exception) { release(connection); throw error }
    }

    private fun checkStatus(connection: HttpURLConnection) {
        val status = connection.responseCode
        if (status !in 200..299) throw NativeWebRtcError(when (status) { 401 -> "unauthorized"; in 300..399 -> "redirect"; else -> "http_error" }, status)
    }
    private fun parseJson(text: String): JSONObject {
        try {
            val parser = JSONTokener(text); val result = parser.nextValue()
            if (parser.nextClean() != '\u0000' || result !is JSONObject) throw NativeWebRtcError("invalid_response")
            return result
        } catch (_: Exception) { throw NativeWebRtcError("invalid_response") }
    }
    private fun release(connection: HttpURLConnection) { synchronized(lock) { connections.remove(connection) }; connection.disconnect() }
    private fun safe(error: Exception): NativeWebRtcError = when (error) { is NativeWebRtcError -> error; is SocketTimeoutException -> NativeWebRtcError("timeout"); else -> NativeWebRtcError("network") }
    private fun current(ticket: Long): Boolean = synchronized(lock) { currentLocked(ticket) }
    private fun currentLocked(ticket: Long): Boolean = !destroyed && generation == ticket
    private fun deliver(ticket: Long, action: () -> Unit) { main.post { if (current(ticket)) action() } }
    private fun submit(ticket: Long, action: () -> Unit) {
        try { operations.execute(Operation(false) { if (current(ticket)) action() }) }
        catch (_: RejectedExecutionException) { failSession(ticket, "busy") }
    }
    private fun deleteSession(session: Session) { runCatching { exchange("DELETE", NativeWebRtcPolicy.session(base, session.id, ""), session.cookie, null, null, 4000) } }
    private fun queueDelete(session: Session?) {
        if (session == null || operations.isShutdown) return
        // Cleanup has priority over candidate jobs and is never generation-cancelled.
        val task = Operation(true) { deleteSession(session) }
        if (!operationQueue.offerFirst(task)) {
            operationQueue.removeIf { it is Operation && !it.cleanup }
            operationQueue.offerFirst(task)
        }
    }
    private fun failSession(ticket: Long, reason: String) {
        val end = stopSession(expectedTicket = ticket) ?: return
        deliver(end) { onClosed(reason) }
    }
    private fun stopSession(expectedTicket: Long? = null, permanent: Boolean = false): Long? {
        val cancelled: List<HttpURLConnection>; val sse: HttpURLConnection?; val end: Long
        synchronized(lock) {
            if (destroyed || (expectedTicket != null && expectedTicket != generation)) return null
            if (permanent) destroyed = true
            val previous = active
            generation++; active = null; opening = false; eventsStarted = false; candidateDrain = false
            end = generation
            queuedCandidates.clear(); sentCandidates = 0; remoteCandidates = 0
            cancelled = connections.filterValues { !it }.keys.toList(); sse = eventConnection; eventConnection = null
            operationQueue.removeIf { it is Operation && !it.cleanup }
            events.queue.clear()
            // Enqueue under the same lock: a concurrent destroy must not shut down the worker first.
            queueDelete(previous)
        }
        // Close the occupied SSE connection first, so its dedicated worker is available immediately.
        sse?.disconnect()
        cancelled.filter { it !== sse }.forEach { it.disconnect() }
        return end
    }
    fun close() { stopSession() }
    fun destroy() {
        stopSession(permanent = true) ?: return
        main.removeCallbacksAndMessages(null)
        events.shutdownNow()
        operations.shutdown() // Already-queued best-effort DELETE is allowed to finish within its timeout.
    }
}
