package org.hometv.launcher

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.media.AudioManager
import android.text.InputType
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Native settings and paired-bridge dialogs. Only the server's existing fixed APIs are used. */
class NativeDialogController(
    private val activity: Activity,
    private val requestJson: (String, String, JSONObject?, (Result<JSONObject>) -> Unit) -> Unit,
    private val appearance: () -> String,
    private val onAppearance: (String) -> Unit,
    private val openSettings: () -> Unit,
    private val onVoice: (() -> Unit)? = null,
    private val background: () -> String = { "weather" },
    private val onBackground: (String) -> Unit = {},
    private val soundEnabled: () -> Boolean = { true },
    private val onSoundEnabled: (Boolean) -> Unit = {},
    private val onSaver: (() -> Unit)? = null,
    private val onPair: (() -> Unit)? = null,
    private val isDark: () -> Boolean = { true },
    private val controls: () -> JSONObject = { JSONObject() },
    private val homeState: () -> JSONObject = { JSONObject() },
    private val domestic: () -> JSONObject = { JSONObject() },
    private val onControlRefresh: () -> Unit = {},
) {
    private data class Panel(val generation: Long, val modal: Dialog, val body: LinearLayout, val content: LinearLayout, val status: TextView, val settings: Boolean = false)
    private val handler = Handler(Looper.getMainLooper())
    private val confirmation = NativeConfirmationPolicy()
    private var generation = 0L
    private var panel: Panel? = null
    private var destroyed = false
    private var settingsTab = "display"
    private data class SettingControl(val kind: String, val key: String)
    fun isOpen() = panel?.modal?.isShowing == true

    fun showSettings(): Unit = ui {
        val p = open("Nastavení", settings = true) ?: return@ui
        val tabs = LinearLayout(activity).apply {
            tag = "settings-segments"
            setPadding(unit(4), unit(4), unit(4), unit(4))
            background = settingsShape(if (isDark()) Color.argb(24, 255, 255, 255) else Color.argb(120, 255, 255, 255), 0, 25f)
        }
        val page = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        p.content.addView(tabs, LinearLayout.LayoutParams(-1, unit(48)))
        p.content.addView(page, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = unit(18) })
        var selected: Button? = null
        for ((id, title) in listOf("display" to "Vzhled", "saver" to "Spořič", "connection" to "Připojení a ovládání")) {
            val tab = settingsButton(title, SettingControl("segment", id)) {
                if (current(p)) { settingsTab = id; renderSettingsPage(p, page) }
            }
            tabs.addView(tab, LinearLayout.LayoutParams(0, -1, 1f).apply { marginEnd = if (id == "connection") 0 else unit(4) })
            if (id == settingsTab) selected = tab
        }
        renderSettingsPage(p, page)
        selected?.requestFocus()
    }

    private fun renderSettingsPage(p: Panel, page: LinearLayout, focusKey: String? = null) {
        if (!current(p)) return
        page.removeAllViews()
        val targets = HashMap<String, Button>()
        fun heading(value: String, top: Int = 0) {
            page.addView(settingsText(value, 19f, false).apply { setPadding(0, unit(top), 0, unit(8)) })
        }
        fun description(value: String) {
            page.addView(settingsText(value, 14f, true).apply { setPadding(0, 0, 0, unit(16)); setLineSpacing(unitf(3f), 1f) })
        }
        fun setting(key: String, title: String, action: () -> Unit): Button = settingsButton(title, SettingControl("action", key)) {
            if (current(p)) action()
        }.also {
            targets[key] = it
            page.addView(it, LinearLayout.LayoutParams(-1, unit(48)).apply { topMargin = unit(10) })
        }
        when (settingsTab) {
            "display" -> {
                heading("Vzhled a pozadí")
                description("Světlý, tmavý nebo automaticky podle slunce u vás doma.")
                val themeRow = LinearLayout(activity)
                for ((id, title) in listOf("light" to "Světlý", "dark" to "Tmavý", "auto" to "Automaticky")) {
                    val b = settingsButton(title, SettingControl("theme", id)) {
                        if (current(p)) { onAppearance(id); renderSettingsPage(p, page, "theme:$id") }
                    }
                    targets["theme:$id"] = b
                    themeRow.addView(b, LinearLayout.LayoutParams(0, unit(48), 1f).apply { marginEnd = if (id == "auto") 0 else unit(10) })
                }
                page.addView(themeRow)
                heading("Pozadí", 20)
                val backgroundRow = LinearLayout(activity)
                for ((id, title) in listOf("weather" to "Počasí", "plain" to "Jednobarevné", "photos" to "Naše fotografie")) {
                    val tile = BackgroundTile(title, id).apply {
                        tag = SettingControl("background", id)
                        setOnClickListener { if (current(p)) { onBackground(id); renderSettingsPage(p, page, "background:$id") } }
                    }
                    targets["background:$id"] = tile
                    backgroundRow.addView(tile, LinearLayout.LayoutParams(0, unit(106), 1f).apply { marginEnd = if (id == "photos") 0 else unit(10) })
                }
                page.addView(backgroundRow)
                val soundRow = LinearLayout(activity).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(unit(16), unit(9), unit(10), unit(9))
                    tag = "settings-sound-row"
                }
                soundRow.addView(settingsText("Zvuk pohybu v nabídce", 14f, false), LinearLayout.LayoutParams(0, -2, 1f))
                val sound = settingsButton(if (soundEnabled()) "Zapnuto" else "Vypnuto", SettingControl("sound", "sound")) {
                    if (current(p)) { onSoundEnabled(!soundEnabled()); renderSettingsPage(p, page, "sound") }
                }
                sound.contentDescription = "Zvuk pohybu v nabídce, " + if (soundEnabled()) "zapnutý" else "vypnutý"
                targets["sound"] = sound
                soundRow.addView(sound, LinearLayout.LayoutParams(unit(116), unit(38)))
                page.addView(soundRow, LinearLayout.LayoutParams(-1, unit(58)).apply { topMargin = unit(20) })
            }
            "saver" -> {
                heading("Fotografie a spořič")
                description("Vaše rodinné fotografie, čas a informace o domově. Šipka nebo Zpět vrátí přehled.")
                val information = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(unit(20), unit(20), unit(20), unit(20))
                    tag = "settings-sound-row"
                }
                information.addView(settingsText("Rodina na velké obrazovce", 18f, false))
                information.addView(settingsText("Vlastní fotografie přidáš na počítači nebo telefonu. Na televizi se objeví ve společné knihovně.", 14f, true).apply { setPadding(0, unit(10), 0, 0); setLineSpacing(unitf(4f), 1f) })
                page.addView(information, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = unit(12) })
                onSaver?.let { action -> setting("saver", "Spustit spořič teď") { closeNow(); action() } }
            }
            else -> {
                heading("Připojení k domácnosti")
                description("Domácí most propojuje televizi s vaším domovem. Připojení změníš jen svým výběrem.")
                onPair?.let { action -> setting("pair", "Spárovat s domácím mostem") { closeNow(); action() } }
                setting("android", "Nastavení Android TV") { closeNow(); openSettings() }
                setting("mobile", "Ovládání z telefonu") { showMobilePairing() }
                setting("controls", "Ovládací centrum") { showControls() }
                onVoice?.let { action -> setting("voice", "Zadat hlasový povel") { closeNow(); action() } }
            }
        }
        applyTheme(p)
        focusKey?.let { targets[it]?.requestFocus() }
    }

    fun showNotices(): Unit = ui {
        val p = open("Centrum upozornění") ?: return@ui
        addButton(p, "Události domácnosti") { showTimeline() }
        addButton(p, "Režim Kino a délka ztišení") { showKino() }
        p.status.text = "Načítám aktuální zprávy…"
        request(p, "GET", "/api/notifications", null) { json ->
            val connected = json.optBoolean("connected") && json.optBoolean("houseConnected")
            p.status.text = if (connected) "Aktuální seznam domácího mostu" else "Některý zdroj není připojený. Seznam nemusí být úplný."
            val notes = json.optJSONArray("notifications")
            if (notes == null || notes.length() == 0) text(p, if (connected) "Žádné aktuální zprávy." else "Aktuální zprávy teď nelze potvrdit.")
            else {
                for (index in 0 until minOf(notes.length(), 40)) {
                    val note = notes.optJSONObject(index) ?: continue
                    section(p, note.optString("title", "Domov").take(160))
                    text(p, note.optString("message").take(2000))
                }
                if (notes.length() > 40) text(p, "Zobrazeno prvních 40 aktuálních zpráv.")
            }
            addButton(p, "Obnovit seznam") { showNotices() }
        }
    }

    fun showKino(): Unit = ui {
        val p = open("Kino a oznámení", height = 460) ?: return@ui
        text(p, "Ztiší běžné bannery na zvolenou dobu. Důležité domácí události a zvonek zůstávají povolené.")
        p.status.text = "Načítám nastavení…"
        request(p, "GET", "/api/notification-preferences", null) { value -> renderKino(p, value) }
    }

    private fun renderKino(p: Panel, value: JSONObject) {
        if (!current(p)) return
        if (value.opt("kino") !is Boolean || value.opt("active") !is Boolean) { p.status.text = "Nastavení se nepodařilo ověřit."; return }
        p.content.removeAllViews()
        text(p, "Vyber délku od 1 minuty do 24 hodin. Zvonek, urgentní upozornění, únik vody a dokončení praní zůstávají povolené.")
        val untilMillis = (value.opt("kinoUntil") as? Number)?.toLong()?.takeIf { it > 0 }
            ?: parseExpiry(value.optString("kinoUntil"))
        val until = untilMillis?.let { SimpleDateFormat("HH:mm", Locale.forLanguageTag("cs-CZ")).format(java.util.Date(it)) }
        p.status.text = when { value.optBoolean("kino") -> "Kino je zapnuté${if (until != null) " do $until" else ""}."; value.optBoolean("active") -> "Běžné bannery jsou ztišené."; else -> "Běžné bannery jsou povolené." }
        val buttons = ArrayList<Button>()
        val duration = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_NUMBER; setSingleLine(true)
            setText((value.optInt("kinoDurationMinutes", 60).takeIf { it in 1..1440 } ?: 60).toString()); selectAll()
            contentDescription = "Délka režimu Kino v minutách, 1 až 1440"
            setTextColor(ink()); setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(24f)); gravity = Gravity.CENTER
            background = buttonShape(if (isDark()) Color.rgb(48, 52, 60) else Color.rgb(231, 234, 239))
        }
        val choice = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        choice.addView(button("−15") { duration.setText(((duration.text.toString().toIntOrNull() ?: 60) - 15).coerceAtLeast(1).toString()) }, LinearLayout.LayoutParams(unit(100), unit(50)))
        choice.addView(duration, LinearLayout.LayoutParams(0, unit(50), 1f).apply { marginStart = unit(10); marginEnd = unit(10) })
        choice.addView(button("+15") { duration.setText(((duration.text.toString().toIntOrNull() ?: 60) + 15).coerceAtMost(1440).toString()) }, LinearLayout.LayoutParams(unit(100), unit(50)))
        p.content.addView(choice, LinearLayout.LayoutParams(-1, -2).apply { topMargin = unit(12); bottomMargin = unit(10) })
        fun save(body: JSONObject) {
            buttons.forEach { it.isEnabled = false }
            p.status.text = "Ukládám nastavení…"
            request(p, "POST", "/api/notification-preferences", body, onFailure = { p.status.text = "Změnu se nepodařilo potvrdit. Obnov nastavení."; addButton(p, "Obnovit stav") { showKino() } }) { renderKino(p, it) }
        }
        buttons.add(addButton(p, if (value.optBoolean("kino")) "Nastavit novou délku Kina" else "Zapnout Kino na zvolenou dobu") {
            val minutes = duration.text.toString().toIntOrNull()
            if (minutes == null || minutes !in 1..1440) duration.error = "Zadej 1 až 1440 minut."
            else save(JSONObject().put("action", "kino").put("enabled", true).put("minutes", minutes))
        })
        if (value.optBoolean("kino")) buttons.add(addButton(p, "Vypnout Kino") { save(JSONObject().put("action", "kino").put("enabled", false)) })
        buttons.add(addButton(p, "Obnovit bannery") { save(JSONObject().put("action", "resume")) }.apply { isEnabled = value.optBoolean("active") })
        buttons.firstOrNull()?.requestFocus()
    }

    fun showNightPlan(): Unit = ui {
        val p = open("Dobrou noc") ?: return@ui
        p.status.text = "Ověřuji původní noční makro a dostupnost jeho zařízení…"
        request(p, "POST", "/api/night/prepare", JSONObject()) { json ->
            val steps = json.optJSONArray("plan")
            val expiry = parseExpiry(json.optString("expiresAt"))
            val readablePlan = steps != null && steps.length() in 1..20 && (0 until steps.length()).all { index ->
                val title = steps.optJSONObject(index)?.optString("title")
                title != null && title.isNotBlank() && title.length <= 250
            }
            if (!json.optBoolean("requiresTripleClick") || !readablePlan || steps == null || expiry == null ||
                !confirmation.arm(json.optString("confirmationId"), expiry, System.currentTimeMillis(), SystemClock.elapsedRealtime())) {
                p.status.text = "Plán nebo jeho platnost se nepodařilo ověřit. Připrav nový přehled."
                addButton(p, "Připravit nový přehled") { showNightPlan() }
                return@request
            }
            text(p, "Spustí se celé existující makro. Přečti všechny kroky; potvrzení vyprší nejpozději za 20 sekund.")
            for (index in 0 until steps.length()) {
                val step = steps.optJSONObject(index) ?: continue
                text(p, "${index + 1}. ${step.optString("title").take(250)}${if (step.opt("identityVerified") == false) " · umístění zámku neověřeno" else ""}")
            }
            val warnings = json.optJSONArray("warnings")
            if (warnings != null) for (index in 0 until minOf(warnings.length(), 10)) text(p, warnings.optString(index).take(500))
            text(p, "Přijetí makra není potvrzení, že všechny jeho větve dokončily zamknutí či vypnutí.")
            p.status.text = "Potvrzení 0/3 · třikrát stiskni potvrzovací tlačítko."
            lateinit var confirm: Button
            confirm = addButton(p, "Potvrdit · 0/3") {
                val now = SystemClock.elapsedRealtime()
                if (!confirmation.armed(now)) {
                    confirm.isEnabled = false; p.status.text = "Potvrzení vypršelo. Připrav nový přehled."
                    addButton(p, "Připravit nový přehled") { showNightPlan() }
                } else {
                    val token = confirmation.click(now)
                    confirm.text = "Potvrdit · ${confirmation.count()}/3"
                    p.status.text = "Potvrzení ${confirmation.count()}/3"
                    if (token != null) {
                        confirm.isEnabled = false; p.status.text = "Odesílám jednorázové potvrzení…"
                        request(p, "POST", "/api/night/commit", JSONObject().put("confirmationId", token), onFailure = {
                            p.status.text = "Spuštění se nepodařilo potvrdit. Stav zařízení ověř samostatně; tento pokus neopakuj."
                        }) { response ->
                            p.status.text = if (response.optBoolean("accepted")) "Makro přijato. Dokončení všech kroků není ověřené; stav domu zkontroluj samostatně." else "Spuštění makra není potvrzené."
                        }
                    }
                }
            }
            // Repeated key-down events never count as extra confirmation clicks.
            confirm.setOnKeyListener { _, code, event -> code in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER) && event.action == KeyEvent.ACTION_DOWN && event.repeatCount > 0 }
            confirm.requestFocus()
            val expire = object : Runnable {
                override fun run() {
                    if (!current(p) || confirmation.count() >= 3) return
                    if (!confirmation.armed(SystemClock.elapsedRealtime())) { confirm.isEnabled = false; p.status.text = "Potvrzení vypršelo. Zavři a připrav nový přehled." }
                    else handler.postDelayed(this, 500)
                }
            }
            handler.postDelayed(expire, 500)
        }
    }

    fun showMobilePairing(): Unit = ui {
        val p = open("Ovládání z telefonu", height = 460) ?: return@ui
        text(p, "Na telefonu připojeném k domácí síti otevři tuto adresu. Zadej jednorázový kód z televize.")
        val address = android.net.Uri.parse(BuildConfig.DASHBOARD_URL).buildUpon().path("/manage.html").clearQuery().fragment(null).build().toString()
        section(p, address)
        p.status.text = "Připravuji jednorázový kód…"
        request(p, "POST", "/api/mobile/pairing", JSONObject()) { response ->
            val code = response.optString("code")
            val expiry = parseExpiry(response.optString("expiresAt"))
            if (!code.matches(Regex("[0-9]{8}")) || expiry == null || expiry <= System.currentTimeMillis()) {
                p.status.text = "Kód není dostupný. Zkus vytvořit nový."; return@request
            }
            section(p, code.chunked(4).joinToString("  "))
            text(p, "Z telefonu lze měnit vzhled, zvuk, spořič a rodinné fotografie.")
            val countdown = object : Runnable {
                override fun run() {
                    if (!current(p)) return
                    val seconds = ((expiry - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                    p.status.text = if (seconds > 0) "Kód platí ještě $seconds s a lze ho použít jednou." else "Platnost kódu skončila. Vytvoř nový kód."
                    if (seconds > 0) handler.postDelayed(this, 1000)
                }
            }
            countdown.run()
            addButton(p, "Vytvořit nový kód") { showMobilePairing() }
        }
    }

    /** Opening is always a fresh, explicit confirmation for the pinned entrance door. */
    fun showDoor(): Unit = ui {
        val p = open("Vchodové dveře", height = 330) ?: return@ui
        p.status.text = "Ověřuji stav zámku…"
        request(p, "GET", "/api/door/status", null) { state ->
            if (state.optString("cameraId") != "entrance" || !state.optBoolean("available")) {
                text(p, state.optString("reason", "Dveře teď nelze bezpečně otevřít.").take(160))
                p.status.text = "Otevření není dostupné."
                return@request
            }
            request(p, "POST", "/api/door/prepare", JSONObject().put("cameraId", "entrance")) { prepared ->
                val token = prepared.optString("confirmationId")
                val expiry = parseExpiry(prepared.optString("expiresAt"))
                if (!token.matches(Regex("[A-Za-z0-9_-]{16,128}")) || expiry == null || expiry <= System.currentTimeMillis() || expiry - System.currentTimeMillis() > 21000) {
                    p.status.text = "Potvrzení není dostupné. Ověř dveře znovu."; return@request
                }
                text(p, "Otevřít vchodové dveře pro návštěvu?")
                val confirm = addButton(p, "Otevřít vchodové dveře") {
                    if (System.currentTimeMillis() >= expiry) { p.status.text = "Potvrzení vypršelo. Ověř dveře znovu."; return@addButton }
                    p.content.findViewWithTag<Button>("door-confirm")?.isEnabled = false
                    p.status.text = "Odesílám povel k otevření…"
                    request(p, "POST", "/api/door/commit", JSONObject().put("confirmationId", token), onFailure = {
                        p.status.text = "Otevření se nepodařilo potvrdit. Ověř stav dveří."
                    }) { response ->
                        p.status.text = if (response.optBoolean("accepted")) "Povel k otevření dveří byl odeslán." else "Otevření nebylo potvrzeno."
                    }
                }.apply {
                    tag = "door-confirm"
                    setOnKeyListener { _, code, event -> code in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER) && event.action == KeyEvent.ACTION_DOWN && event.repeatCount > 0 }
                }
                p.status.text = "Potvrzení platí 20 sekund."
                // Focus stays on Close. Releasing the button that opened the popup cannot open a door.
                handler.postDelayed({ if (current(p) && confirm.isEnabled) { confirm.isEnabled = false; p.status.text = "Potvrzení vypršelo. Ověř dveře znovu." } }, (expiry - System.currentTimeMillis()).coerceAtLeast(1))
            }
        }
    }

    fun showTimeline(): Unit = ui {
        val p = open("Události domácnosti", height = 560) ?: return@ui
        p.status.text = "Načítám události…"
        request(p, "GET", "/api/timeline?limit=100", null) { json ->
            val entries = json.optJSONArray("events") ?: JSONArray()
            var page = 0
            fun renderPage() {
                if (!current(p)) return
                p.content.removeAllViews()
                val pages = ((entries.length() + 2) / 3).coerceAtLeast(1)
                if (entries.length() == 0) text(p, "Zatím tu nejsou žádné události.")
                for (index in page * 3 until minOf(entries.length(), page * 3 + 3)) {
                    val entry = entries.optJSONObject(index) ?: continue
                    val date = parseExpiry(entry.optString("occurredAt"))?.let { SimpleDateFormat("d. M. HH:mm", Locale.forLanguageTag("cs-CZ")).format(java.util.Date(it)) } ?: "Čas neověřený"
                    section(p, "$date · ${entry.optString("title", "Domov").take(90)}")
                    text(p, entry.optString("message").take(150))
                }
                val row = LinearLayout(activity)
                row.addView(button("‹ Předchozí") { page--; renderPage() }.apply { isEnabled = page > 0 }, LinearLayout.LayoutParams(0, unit(46), 1f))
                row.addView(button("Další ›") { page++; renderPage() }.apply { isEnabled = page + 1 < pages }, LinearLayout.LayoutParams(0, unit(46), 1f).apply { marginStart = unit(10) })
                p.content.addView(row)
                p.status.text = "Strana ${page + 1}/$pages" + if (json.optBoolean("persistent")) "" else " · historie se dočasně neukládá"
            }
            renderPage()
        }
    }

    /** Read-only v2 room snapshot with fixed pages for remote navigation. */
    fun showRoom(room: JSONObject, pageIndex: Int = 0): Unit = ui {
        fun label(value: JSONObject, fallback: String): String {
            val name = (value.opt("name") as? String)?.replace(Regex("[\\p{Cntrl}\\s]+"), " ")?.trim().orEmpty()
            return name.takeIf { it.isNotBlank() && !it.contains("://") &&
                !it.startsWith("{") && !it.startsWith("[") && !Regex("^[a-z_]+\\.[a-z0-9_]+$").matches(it) }?.take(64) ?: fallback
        }
        fun number(value: JSONObject?, key: String): Number? = (value?.opt(key) as? Number)?.takeIf { it.toDouble().isFinite() }
        fun numeric(value: Number): String = runCatching {
            java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString().replace('.', ',')
        }.getOrElse { "Neověřeno" }
        fun metricUnit(value: JSONObject?): String = (value?.opt("unit") as? String)?.takeIf {
            it.length in 1..24 && it.none { c -> c.isISOControl() } && !it.contains("://")
        }?.let { " $it" }.orEmpty()
        fun measurement(value: JSONObject?): String = when {
            value == null || value.opt("entityId") !is String -> "Nesleduje se"
            value.opt("available") != true -> "Nedostupné"
            else -> number(value, "value")?.let { numeric(it) + metricUnit(value) } ?: "Neověřeno"
        }
        fun reported(state: String): String = when (state) {
            "heat", "heating" -> "Vytápění"
            "cool", "cooling" -> "Chlazení"
            "heat_cool" -> "Topení a chlazení"
            "auto" -> "Automaticky"
            "dry", "drying" -> "Odvlhčování"
            "fan_only", "fan" -> "Ventilace"
            "idle" -> "V klidu"
            "off" -> "Vypnuto"
            "on" -> "Zapnuto"
            else -> "Neověřeno"
        }
        fun target(value: JSONObject): String {
            if (value.opt("available") != true) return "Neověřeno"
            val low = number(value, "targetLow")
            val high = number(value, "targetHigh")
            // A range stays a range; never manufacture a scalar setpoint from it.
            return when {
                low != null && high != null -> numeric(low) + "–" + numeric(high) + metricUnit(value)
                low != null -> "od " + numeric(low) + metricUnit(value)
                high != null -> "do " + numeric(high) + metricUnit(value)
                else -> number(value, "targetTemperature")?.let { numeric(it) + metricUnit(value) } ?: "Neověřeno"
            }
        }
        fun elapsed(value: JSONObject): String {
            val seconds = number(value, "elapsedSeconds")?.toDouble()?.takeIf { it >= 0 && it <= Long.MAX_VALUE.toDouble() }?.toLong() ?: return ""
            val duration = when {
                seconds < 60 -> "$seconds s"
                seconds < 3600 -> "${seconds / 60} min"
                seconds < 86400 -> "${seconds / 3600} h"
                else -> "${seconds / 86400} d"
            }
            return " · od změny $duration"
        }
        fun binary(value: JSONObject, on: String, off: String): String = when {
            value.opt("available") != true -> "Nedostupné"
            value.opt("active") == true -> on + elapsed(value)
            value.opt("active") == false -> off + elapsed(value)
            else -> "Stav neověřený"
        }
        fun state(value: JSONObject): String {
            if (value.opt("available") != true) return "Nedostupné"
            if (value.opt("active") is Boolean) return binary(value, "Hlášeno: aktivní", "Hlášeno: neaktivní")
            return when (value.optString("state")) {
                "on" -> "Zapnuto"; "off" -> "Vypnuto"; "idle" -> "V klidu"
                "playing" -> "Přehrává"; "paused" -> "Pozastaveno"; "buffering" -> "Načítání"; "standby" -> "Pohotovostní režim"
                "run", "running" -> "Běží"; "pause" -> "Pozastaveno"; "stop", "stopped" -> "Zastaveno"
                "finished", "completed", "complete" -> "Dokončeno"; "waiting" -> "Čeká"; "ready" -> "Připraveno"
                "washing", "wash" -> "Praní"; "rinsing", "rinse" -> "Máchání"; "spinning", "spin" -> "Odstřeďování"
                "drying", "dry" -> "Sušení"; "draining", "drain" -> "Vypouštění"; "weightSensing" -> "Vážení prádla"
                "error", "fault" -> "Chyba"
                "sunny" -> "Jasno"; "clear-night" -> "Jasná noc"; "partlycloudy" -> "Polojasno"; "cloudy" -> "Zataženo"
                "rainy" -> "Déšť"; "pouring" -> "Silný déšť"; "snowy" -> "Sněžení"; "snowy-rainy" -> "Déšť se sněhem"
                "fog" -> "Mlha"; "hail" -> "Kroupy"; "lightning" -> "Bouřka"; "lightning-rainy" -> "Bouřka s deštěm"
                "windy", "windy-variant" -> "Větrno"; "exceptional" -> "Mimořádné počasí"
                else -> "Stav neověřený"
            }
        }
        fun items(key: String): List<JSONObject> {
            val list = room.optJSONArray(key) ?: return emptyList()
            return (0 until minOf(list.length(), 32)).mapNotNull { list.optJSONObject(it) }
        }
        val presence = items("presence")
        val equipment = items("equipment")
        val presencePages = ((presence.size + 3) / 4).coerceAtLeast(1)
        val equipmentPages = ((equipment.size + 3) / 4).coerceAtLeast(1)
        val pages = 2 + presencePages + equipmentPages
        val page = pageIndex.coerceIn(0, pages - 1)
        val p = open(label(room, "Místnost"), height = 540) ?: return@ui
        p.body.getChildAt(0).apply { layoutParams = LinearLayout.LayoutParams(-1, unit(46)) }
        ((p.body.getChildAt(0) as LinearLayout).getChildAt(0) as TextView).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        p.status.apply {
            maxLines = 1
            includeFontPadding = false
            layoutParams = LinearLayout.LayoutParams(-1, unit(32))
        }
        // open() retains its existing scrolling behavior for all other dialogs.
        // Replace only this panel's wrapper with its fixed-height content column.
        (p.content.parent as? ScrollView)?.let { scroll ->
            val index = p.body.indexOfChild(scroll)
            val params = scroll.layoutParams
            scroll.removeView(p.content)
            p.body.removeView(scroll)
            p.body.addView(p.content, index, params)
        }
        fun row(value: String) {
            text(p, value)
            (p.content.getChildAt(p.content.childCount - 1) as TextView).apply {
                maxLines = 3
                ellipsize = android.text.TextUtils.TruncateAt.END
                layoutParams = LinearLayout.LayoutParams(-1, unit(72))
            }
        }
        fun heading(value: String) {
            section(p, value)
            (p.content.getChildAt(p.content.childCount - 1) as TextView).apply {
                maxLines = 1
                layoutParams = LinearLayout.LayoutParams(-1, unit(45))
            }
        }
        val category: String
        when {
            page == 0 -> {
                category = "Prostředí"
                heading(category)
                for ((key, name) in listOf("temperature" to "Teplota", "humidity" to "Vlhkost", "co2" to "CO₂", "pm25" to "PM2.5")) {
                    text(p, "$name: ${measurement(room.optJSONObject(key))}")
                }
                if (room.opt("available") != true) text(p, "Údaje místnosti teď nejsou dostupné.")
            }
            page == 1 -> {
                category = "Regulace a topení"
                val climate = room.optJSONObject("climate")
                heading("Regulátor")
                when {
                    climate == null || climate.opt("entityId") !is String -> text(p, "V této místnosti není připojený regulátor.")
                    climate.opt("available") != true -> text(p, "Regulátor není dostupný.\nHlášený stav a cílová teplota nejsou ověřené.")
                    else -> {
                        text(p, "Režim: ${reported(climate.optString("state"))} · Regulátor hlásí: ${reported(climate.optString("reportedAction"))}")
                        text(p, "Cíl: ${target(climate)}\nTeplota hlášená regulátorem: ${number(climate, "currentTemperature")?.let { numeric(it) + metricUnit(climate) } ?: "Neověřeno"}")
                    }
                }
                heading("Skutečné topení")
                val evidence = room.optJSONObject("heatingEvidence")
                val watts = number(evidence, "powerW")?.takeIf { it.toDouble() >= 0 }
                val active = room.opt("heatingActive") as? Boolean
                val verified = evidence?.optString("kind") == "measured_power" && evidence.opt("available") == true &&
                    watts != null && active != null && active == (watts.toDouble() > 0)
                text(p, if (verified) "${if (active == true) "Topí" else "Netopí"} · Měřený příkon: ${numeric(watts!!)} W"
                    else "Neověřeno · skutečný chod topení není potvrzen měřeným příkonem.")
            }
            page < 2 + presencePages -> {
                category = "Přítomnost"
                heading(category)
                if (presence.isEmpty()) text(p, "Přítomnost se v této místnosti nesleduje.")
                val start = (page - 2) * 4
                for (item in presence.drop(start).take(4)) row(label(item, "Přítomnost") + "\n" + binary(item, "Zjištěna přítomnost", "Bez přítomnosti"))
            }
            else -> {
                category = "Vybavení"
                heading(category)
                if (equipment.isEmpty()) text(p, "V této místnosti není připojené žádné vybavení.")
                val start = (page - 2 - presencePages) * 4
                for (item in equipment.drop(start).take(4)) {
                    val detail = when (item.optString("kind")) {
                        "temperature", "power", "distance", "level", "rain_rate", "wind_speed", "flow" -> measurement(item)
                        "door", "window" -> binary(item, "Otevřeno", "Zavřeno")
                        "fan", "purifier" -> binary(item, "Zapnuto", "Vypnuto") +
                            if (item.opt("available") == true) number(item, "percentage")?.takeIf { it.toDouble() in 0.0..100.0 }?.let { " · ${numeric(it)} %" }.orEmpty() else ""
                        "climate" -> if (item.opt("available") != true) "Regulátor není dostupný" else
                            "Režim: ${reported(item.optString("state"))} · Hlásí: ${reported(item.optString("reportedAction"))}\nCíl: ${target(item)}"
                        else -> state(item)
                    }
                    row(label(item, "Zařízení") + "\n" + detail)
                }
            }
        }
        // At most four 72-unit rows + a 45-unit heading + 54-unit navigation = 387.
        // Fixed header/status leave 540 - 44 padding - 46 - 32 - 16 margin = 402.
        val space = View(activity)
        p.content.addView(space, LinearLayout.LayoutParams(-1, 0, 1f))
        val navigation = LinearLayout(activity)
        val previous = button("‹ Předchozí") { if (current(p)) showRoom(room, page - 1) }.apply { isEnabled = page > 0 }
        val next = button("Další ›") { if (current(p)) showRoom(room, page + 1) }.apply { isEnabled = page + 1 < pages }
        navigation.addView(previous, LinearLayout.LayoutParams(0, unit(46), 1f))
        navigation.addView(next, LinearLayout.LayoutParams(0, unit(46), 1f).apply { marginStart = unit(8) })
        p.content.addView(navigation, LinearLayout.LayoutParams(-1, unit(46)).apply { topMargin = unit(8) })
        p.status.text = "$category · Strana ${page + 1}/$pages"
        if (next.isEnabled) next.requestFocus() else previous.requestFocus()
    }

    fun showControls(sectionId: String = "lights", pageIndex: Int = 0): Unit = ui {
        val p = open("Ovládací centrum", height = 540) ?: return@ui
        val capability = controls()
        val tabs = LinearLayout(activity)
        for ((id, name) in listOf("lights" to "Světla", "temperature" to "Teplota", "tv" to "Televize")) {
            tabs.addView(button(name) { showControls(id) }.apply { isSelected = sectionId == id }, LinearLayout.LayoutParams(0, unit(46), 1f).apply { marginEnd = unit(6) })
        }
        p.content.addView(tabs)
        fun send(buttons: List<Button>, body: JSONObject) {
            buttons.forEach { it.isEnabled = false }; p.status.text = "Odesílám změnu…"
            request(p, "POST", "/api/control", body, onFailure = {
                p.status.text = "Změnu se nepodařilo potvrdit. Ověř aktuální stav."; onControlRefresh()
                addButton(p, "Obnovit ovládací centrum") { showControls(sectionId, pageIndex) }
            }) { result ->
                if (result.optBoolean("accepted")) { p.status.text = "Povel odeslán. Aktualizuji stav…"; onControlRefresh()
                    handler.postDelayed({ if (current(p)) showControls(sectionId, pageIndex) }, 1800)
                } else p.status.text = "Změna nebyla potvrzena."
            }
        }
        if (sectionId == "tv") {
            section(p, "Zvuk televize")
            val manager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val row = LinearLayout(activity)
            for ((label, direction) in listOf("Tišeji" to AudioManager.ADJUST_LOWER, "Hlasitěji" to AudioManager.ADJUST_RAISE)) row.addView(button(label) {
                manager.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
            }, LinearLayout.LayoutParams(0, unit(46), 1f).apply { marginEnd = unit(8) })
            p.content.addView(row)
            addButton(p, "Kino · nastavit délku") { showKino() }
            addButton(p, "Události domácnosti") { showTimeline() }
            addButton(p, "Ovládání z telefonu") { showMobilePairing() }
            addButton(p, "Nastavení Android TV") { closeNow(); openSettings() }
        } else {
            val list = capability.optJSONArray(if (sectionId == "lights") "lights" else "temperatures") ?: JSONArray()
            val pages = ((list.length() + 2) / 3).coerceAtLeast(1)
            val page = pageIndex.coerceIn(0, pages - 1)
            if (!capability.optBoolean("available")) text(p, "Ovládání domácnosti není připojené.")
            if (list.length() == 0) text(p, "Zatím tu nejsou nastavené žádné prvky.")
            for (index in page * 3 until minOf(list.length(), page * 3 + 3)) {
                val item = list.optJSONObject(index) ?: continue
                val id = item.optString("id")
                val row = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
                val stateItems = if (sectionId == "lights") homeState().optJSONArray("lights") else domestic().optJSONArray("rooms")
                val state = (0 until (stateItems?.length() ?: 0)).mapNotNull { stateItems?.optJSONObject(it) }.firstOrNull { it.optString(if (sectionId == "lights") "entityId" else "id") == id }
                val subtitle = if (sectionId == "lights") when (state?.optString("state")) { "on" -> "Zapnuto"; "off" -> "Vypnuto"; else -> "Stav neověřený" }
                    else (state?.opt("targetTemperature") as? Number)?.let { "$it °C" } ?: "Automatický rozsah · jen náhled"
                row.addView(settingsText(item.optString("name", "Domov") + "\n" + subtitle, 15f, false), LinearLayout.LayoutParams(0, -2, 1f))
                val buttons = ArrayList<Button>()
                if (sectionId == "lights") {
                    for ((label, on) in listOf("Zapnout" to true, "Vypnout" to false)) {
                        val b = button(label) { send(buttons, JSONObject().put("type", "light").put("id", id).put("on", on)) }
                        b.isEnabled = capability.optBoolean("available") && state?.optString("state") in listOf("on", "off")
                        buttons.add(b); row.addView(b, LinearLayout.LayoutParams(unit(108), unit(46)).apply { marginStart = unit(8) })
                    }
                } else {
                    for ((label, delta) in listOf("−0,5°" to -0.5, "+0,5°" to 0.5)) {
                        val b = button(label) { send(buttons, JSONObject().put("type", "temperature").put("id", id).put("delta", delta)) }
                        b.isEnabled = capability.optBoolean("available") && state?.opt("targetTemperature") is Number
                        buttons.add(b); row.addView(b, LinearLayout.LayoutParams(unit(108), unit(46)).apply { marginStart = unit(8) })
                    }
                }
                p.content.addView(row, LinearLayout.LayoutParams(-1, unit(82)).apply { topMargin = unit(8) })
            }
            if (pages > 1) {
                val nav = LinearLayout(activity)
                nav.addView(button("‹ Předchozí") { showControls(sectionId, page - 1) }.apply { isEnabled = page > 0 }, LinearLayout.LayoutParams(0, unit(46), 1f))
                nav.addView(button("Další ›") { showControls(sectionId, page + 1) }.apply { isEnabled = page + 1 < pages }, LinearLayout.LayoutParams(0, unit(46), 1f).apply { marginStart = unit(8) })
                p.content.addView(nav)
            }
            p.status.text = "Strana ${page + 1}/$pages"
        }
        tabs.getChildAt(listOf("lights", "temperature", "tv").indexOf(sectionId).coerceAtLeast(0))?.requestFocus()
    }

    private fun parseExpiry(value: String): Long? {
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z").matches(value)) return null
        return runCatching { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { isLenient = false; timeZone = TimeZone.getTimeZone("UTC") }.parse(value)?.time }.getOrNull()
    }

    private fun request(p: Panel, method: String, path: String, body: JSONObject?, onFailure: (() -> Unit)? = null, complete: (JSONObject) -> Unit) {
        var delivered = false
        val receive: (Result<JSONObject>) -> Unit = { result -> ui {
            if (!delivered && current(p)) {
                delivered = true
                result.fold(complete) { onFailure?.invoke() ?: run { p.status.text = "Domácí most není dostupný nebo spojení není ověřené." } }
            }
        } }
        try { requestJson(method, path, body, receive) } catch (_: Exception) { receive(Result.failure(IllegalStateException("Request unavailable"))) }
    }

    private fun open(title: String, settings: Boolean = false, height: Int = 660): Panel? {
        if (destroyed || activity.isFinishing || activity.isDestroyed) return null
        closeNow()
        val modal = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val horizontal = if (settings) unit(28) else dp(28)
            val vertical = if (settings) unit(24) else dp(22)
            setPadding(horizontal, vertical, horizontal, vertical)
            background = if (settings) settingsPanelBackground() else panelBackground()
        }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(activity).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(24f))
            setTextColor(ink())
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        val close = if (settings) settingsButton("×", SettingControl("close", "close")) { close() }.apply {
            contentDescription = "Zavřít nastavení"
            setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(24f))
            setPadding(0, 0, 0, 0)
        } else button("Zavřít") { close() }
        header.addView(close, if (settings) LinearLayout.LayoutParams(unit(36), unit(36)) else LinearLayout.LayoutParams(-2, -2))
        body.addView(header)
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        if (settings) {
            // The three settings pages are designed to fit. Do not hide their controls in a scroll view.
            body.addView(content, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = unit(20) })
        } else {
            val scroll = ScrollView(activity).apply { isFillViewport = false }
            scroll.addView(content)
            body.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(16) })
        }
        val status = TextView(activity).apply { setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(14f)); setTextColor(mutedInk()); setPadding(0, dp(14), 0, 0) }
        if (settings) status.visibility = View.GONE
        body.addView(status)
        val p = Panel(++generation, modal, body, content, status, settings)
        panel = p; modal.setContentView(body)
        modal.setOnDismissListener { if (panel === p) closeNow(false) }
        modal.setOnKeyListener { _, code, event -> if (code == KeyEvent.KEYCODE_BACK) { if (event.action == KeyEvent.ACTION_UP) close(); true } else false }
        modal.show()
        modal.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            if (settings) {
                setLayout(minOf(unit(800), 1100), unit(630))
                addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                setDimAmount(.24f)
            } else {
                setLayout(minOf(unit(800), 1100), unit(height.coerceIn(280, 660)))
                addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                setDimAmount(.24f)
            }
        }
        close.requestFocus()
        return p
    }
    private fun current(p: Panel) = !destroyed && panel === p && generation == p.generation && p.modal.isShowing
    private fun section(p: Panel, value: String) { p.content.addView(TextView(activity).apply { text = value; setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(17f)); setTextColor(ink()); setPadding(0, dp(18), 0, dp(6)) }) }
    private fun text(p: Panel, value: String) { p.content.addView(TextView(activity).apply { text = value; setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(14f)); setTextColor(mutedInk()); setPadding(0, dp(5), 0, dp(7)); setLineSpacing(unitf(3f), 1f) }) }
    private fun addButton(p: Panel, value: String, action: () -> Unit): Button = button(value) { if (current(p)) action() }.also { p.content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(7) }) }
    private fun button(value: String, action: () -> Unit) = Button(activity).apply {
        text = value; isAllCaps = false; setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(14f)); setTextColor(ink()); gravity = Gravity.CENTER_VERTICAL; setPadding(dp(20), dp(12), dp(20), dp(12))
        minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0; includeFontPadding = false
        background = buttonBackground()
        stateListAnimator = null
        if (Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
        setOnClickListener { action() }
    }
    private fun ink(): Int = if (isDark()) Color.rgb(246, 247, 250) else Color.rgb(36, 40, 47)
    private fun mutedInk(): Int = if (isDark()) Color.rgb(195, 199, 208) else Color.rgb(91, 98, 110)
    private fun panelBackground() = settingsPanelBackground()
    private fun settingsPanelBackground() = GradientDrawable(GradientDrawable.Orientation.TL_BR,
        if (isDark()) intArrayOf(Color.argb(244, 55, 60, 70), Color.argb(247, 34, 38, 47))
        else intArrayOf(Color.argb(244, 249, 251, 253), Color.argb(244, 232, 237, 243))).apply {
        cornerRadius = unitf(28f)
        setStroke(unit(1).coerceAtLeast(1), if (isDark()) Color.argb(78, 255, 255, 255) else Color.argb(230, 255, 255, 255))
    }
    private fun settingsShape(fill: Int, border: Int = 0, radius: Float = 18f) = GradientDrawable().apply {
        setColor(fill); cornerRadius = unitf(radius)
        if (border != 0) setStroke(unit(1).coerceAtLeast(1), border)
    }
    private fun settingsText(value: String, size: Float, secondary: Boolean) = TextView(activity).apply {
        text = value; tag = if (secondary) "settings-secondary" else "settings-text"
        setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(size)); setTextColor(if (secondary) mutedInk() else ink())
        includeFontPadding = false
        if (!secondary) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private fun settingsButton(value: String, control: SettingControl, action: () -> Unit) = Button(activity).apply {
        text = value; tag = control; isAllCaps = false; includeFontPadding = false
        minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
        gravity = Gravity.CENTER; setPadding(unit(12), 0, unit(12), 0)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, unitf(14f)); setTextColor(ink())
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        stateListAnimator = null
        if (Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
        setOnClickListener { action() }
        styleSettingButton(this, control)
    }
    private fun styleSettingButton(view: Button, control: SettingControl) {
        val selected = when (control.kind) {
            "segment" -> settingsTab == control.key
            "theme" -> appearance() == control.key
            "background" -> (background().takeIf { it in listOf("weather", "plain", "photos") } ?: "weather") == control.key
            "sound" -> soundEnabled()
            else -> false
        }
        view.isSelected = selected
        view.setTextColor(ink())
        val radius = if (control.kind in listOf("segment", "sound", "close")) 24f else 17f
        val border = if (isDark()) Color.argb(38, 255, 255, 255) else Color.argb(95, 174, 185, 200)
        val idle = if (control.kind == "segment") Color.TRANSPARENT else if (isDark()) Color.argb(13, 255, 255, 255) else Color.argb(75, 255, 255, 255)
        view.background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), settingsShape(if (isDark()) Color.rgb(84, 91, 106) else Color.WHITE, if (isDark()) Color.argb(210, 237, 244, 255) else Color.WHITE, radius))
            addState(intArrayOf(android.R.attr.state_pressed), settingsShape(if (isDark()) Color.rgb(77, 85, 101) else Color.rgb(218, 226, 237), border, radius))
            addState(intArrayOf(android.R.attr.state_selected), settingsShape(if (isDark()) Color.argb(39, 235, 243, 255) else Color.argb(223, 255, 255, 255), border, radius))
            addState(intArrayOf(), settingsShape(idle, if (control.kind == "segment") 0 else border, radius))
        }
        view.invalidate()
    }
    /** Static local swatches illustrate a choice; they never pretend to be current weather or family photos. */
    private inner class BackgroundTile(private val label: String, private val choice: String) : Button(activity) {
        private val brush = Paint(Paint.ANTI_ALIAS_FLAG)
        private val mountain = Path()
        init {
            text = label; contentDescription = label; isAllCaps = false
            minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
            setPadding(0, 0, 0, 0); stateListAnimator = null
            if (Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
        }
        override fun onDraw(canvas: Canvas) {
            val swatch = RectF(unitf(10f), unitf(10f), width - unitf(10f), height - unitf(34f))
            brush.shader = when (choice) {
                "weather" -> LinearGradient(0f, swatch.top, width.toFloat(), swatch.bottom, intArrayOf(Color.rgb(168, 207, 230), Color.rgb(231, 238, 241)), null, Shader.TileMode.CLAMP)
                "photos" -> LinearGradient(0f, swatch.top, 0f, swatch.bottom, intArrayOf(Color.rgb(168, 190, 195), Color.rgb(103, 131, 122)), null, Shader.TileMode.CLAMP)
                else -> null
            }
            brush.color = if (isDark()) Color.rgb(55, 60, 70) else Color.rgb(211, 219, 231)
            canvas.drawRoundRect(swatch, unitf(10f), unitf(10f), brush); brush.shader = null
            val saved = canvas.save(); canvas.clipRect(swatch)
            if (choice == "weather") {
                brush.color = Color.rgb(249, 223, 169); canvas.drawCircle(swatch.left + swatch.width() * .72f, swatch.top + swatch.height() * .38f, unitf(13f), brush)
                brush.color = Color.argb(196, 244, 249, 251)
                NativeCloudSilhouette.build(mountain, swatch.left + swatch.width() * .12f,
                    swatch.top + swatch.height() * .37f, swatch.width() * .59f, swatch.height() * .51f)
                canvas.drawPath(mountain, brush)
            } else if (choice == "photos") {
                brush.color = Color.rgb(226, 219, 186); canvas.drawCircle(swatch.right - unitf(29f), swatch.top + unitf(18f), unitf(7f), brush)
                mountain.reset(); mountain.moveTo(swatch.left, swatch.bottom); mountain.lineTo(swatch.left + swatch.width() * .28f, swatch.top + swatch.height() * .42f); mountain.lineTo(swatch.left + swatch.width() * .54f, swatch.bottom); mountain.close()
                brush.color = Color.rgb(80, 112, 103); canvas.drawPath(mountain, brush)
                mountain.reset(); mountain.moveTo(swatch.left + swatch.width() * .27f, swatch.bottom); mountain.lineTo(swatch.left + swatch.width() * .69f, swatch.top + swatch.height() * .29f); mountain.lineTo(swatch.right, swatch.bottom); mountain.close()
                brush.color = Color.rgb(57, 88, 83); canvas.drawPath(mountain, brush)
            }
            canvas.restoreToCount(saved)
            brush.color = ink(); brush.textSize = unitf(14f); brush.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            canvas.drawText(label, (width - brush.measureText(label)) / 2f, height - unitf(13f), brush)
        }
    }
    private fun buttonShape(fill: Int) = GradientDrawable().apply { setColor(fill); cornerRadius = unitf(20f) }
    private fun buttonBackground() = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_focused), buttonShape(if (isDark()) Color.rgb(73, 78, 88) else Color.rgb(217, 223, 232)))
        addState(intArrayOf(android.R.attr.state_pressed), buttonShape(if (isDark()) Color.rgb(85, 91, 102) else Color.rgb(203, 210, 220)))
        addState(intArrayOf(android.R.attr.state_selected), buttonShape(if (isDark()) Color.rgb(61, 66, 76) else Color.rgb(221, 227, 236)))
        addState(intArrayOf(), buttonShape(if (isDark()) Color.rgb(48, 52, 60) else Color.rgb(231, 234, 239)))
    }
    private fun applyTheme(p: Panel) {
        p.body.background = if (p.settings) settingsPanelBackground() else panelBackground()
        fun walk(view: View) {
            if (view is Button) {
                val control = view.tag as? SettingControl
                if (control != null) styleSettingButton(view, control) else { view.setTextColor(ink()); view.background = buttonBackground() }
            } else if (view is TextView) view.setTextColor(if (view === p.status || view.tag == "settings-secondary") mutedInk() else ink())
            if (view.tag == "settings-segments") view.background = settingsShape(if (isDark()) Color.argb(24, 255, 255, 255) else Color.argb(120, 255, 255, 255), 0, 25f)
            if (view.tag == "settings-sound-row") view.background = settingsShape(if (isDark()) Color.argb(12, 255, 255, 255) else Color.argb(85, 255, 255, 255), 0, 18f)
            if (view is android.view.ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index))
        }
        walk(p.body)
    }
    private fun dp(value: Int) = unit(value)
    private fun unitf(value: Float): Float = value * minOf(activity.resources.displayMetrics.widthPixels / 1440f, activity.resources.displayMetrics.heightPixels / 810f)
    private fun unit(value: Int): Int = unitf(value.toFloat()).toInt()
    private fun ui(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else handler.post { action() } }
    fun close(): Unit = ui { closeNow() }
    fun onPause(): Unit = close()
    fun onDestroy(): Unit = ui { destroyed = true; closeNow() }
    private fun closeNow(dismiss: Boolean = true) { confirmation.clear(); generation++; handler.removeCallbacksAndMessages(null); val old = panel; panel = null; if (dismiss) runCatching { old?.modal?.dismiss() } }
}
