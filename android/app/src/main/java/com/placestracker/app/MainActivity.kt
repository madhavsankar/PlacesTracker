package com.placestracker.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import org.json.JSONObject
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "places_tracker_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val PLACEHOLDER_URL = "https://places-tracker.example.workers.dev"
    }

    private lateinit var webView: WebView
    private var pendingPermissionRequest: PermissionRequest? = null
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var lastWebClientId: String = ""

    private val googleSignInLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        try {
            val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
            val account = task.getResult(ApiException::class.java)
            val idToken = account?.idToken ?: ""
            val email = account?.email?.trim()?.lowercase() ?: ""
            sendAuthResultToWeb(idToken, email, "")
        } catch (e: ApiException) {
            if (result.resultCode != Activity.RESULT_CANCELED) {
                sendAuthResultToWeb(
                    "",
                    "",
                    "Google Sign-In failed (code ${e.statusCode}). Ensure SHA-1 is added in Firebase."
                )
            }
        }
    }

    private fun sendAuthResultToWeb(idToken: String, email: String, error: String) {
        val payload = JSONObject().apply {
            put("idToken", idToken)
            put("email", email)
            put("error", error)
        }.toString()
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript(
                    "if(window.onAndroidGoogleSignInResult) window.onAndroidGoogleSignInResult($payload);",
                    null
                )
            }
        }
    }

    inner class AndroidAuthBridge {
        @JavascriptInterface
        fun signIn(webClientId: String?) {
            val cleanClientId = (webClientId ?: "").trim()
            lastWebClientId = cleanClientId
            runOnUiThread {
                val gsoBuilder = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                    .requestEmail()
                if (cleanClientId.isNotEmpty()) {
                    gsoBuilder.requestIdToken(cleanClientId)
                }
                val client = GoogleSignIn.getClient(this@MainActivity, gsoBuilder.build())
                client.signOut().addOnCompleteListener {
                    googleSignInLauncher.launch(client.signInIntent)
                }
            }
        }

        @JavascriptInterface
        fun signOut() {
            runOnUiThread {
                val gsoBuilder = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                    .requestEmail()
                if (lastWebClientId.isNotEmpty()) {
                    gsoBuilder.requestIdToken(lastWebClientId)
                }
                GoogleSignIn.getClient(this@MainActivity, gsoBuilder.build()).signOut()
            }
        }
    }

    private val audioPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        pendingPermissionRequest?.let { req ->
            if (granted) {
                req.grant(req.resources)
            } else {
                req.deny()
            }
            pendingPermissionRequest = null
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileUploadCallback ?: return@registerForActivityResult
        fileUploadCallback = null
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val clipData = data?.clipData
            val uris = when {
                clipData != null && clipData.itemCount > 0 -> Array(clipData.itemCount) { i ->
                    clipData.getItemAt(i).uri
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            callback.onReceiveValue(uris)
        } else {
            callback.onReceiveValue(null)
        }
    }

    private fun getBaseUrl(): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_SERVER_URL, null)?.trim()?.trimEnd('/')
        if (!saved.isNullOrBlank()) return saved
        return BuildConfig.DEFAULT_WEB_URL.trimEnd('/')
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        try {
            FirebaseApp.initializeApp(this)
            FirebaseAnalytics.getInstance(this)
        } catch (_: Exception) {
            // Ignored when built without google-services.json
        }

        window.statusBarColor = Color.parseColor("#0B0F19")
        window.navigationBarColor = Color.parseColor("#0F172A")

        webView = WebView(this)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.textZoom = 100
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setSupportMultipleWindows(true)
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.userAgentString = settings.userAgentString.replace("; wv", "")
        val online = isOnline()
        settings.cacheMode = if (online) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        if (online) {
            webView.clearCache(true)
        }

        webView.setBackgroundColor(Color.parseColor("#0B0F19"))
        webView.addJavascriptInterface(AndroidAuthBridge(), "PlacesAndroidAuth")
        android.webkit.CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                val base = getBaseUrl()
                if (
                    url.startsWith(base) ||
                    url.contains(".cloudflareaccess.com") ||
                    url.contains("accounts.google.com") ||
                    url.contains(".google.com") ||
                    url.contains("gstatic.com") ||
                    url.contains("googleapis.com")
                ) {
                    return false
                }
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?
            ): Boolean {
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val popupDialog = android.app.Dialog(
                    this@MainActivity,
                    android.R.style.Theme_Black_NoTitleBar_Fullscreen
                )
                val popupWebView = WebView(this@MainActivity).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.databaseEnabled = true
                    settings.setSupportMultipleWindows(true)
                    settings.javaScriptCanOpenWindowsAutomatically = true
                    settings.userAgentString = settings.userAgentString.replace("; wv", "")
                    android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    webViewClient = WebViewClient()
                    webChromeClient = object : WebChromeClient() {
                        override fun onCloseWindow(window: WebView?) {
                            try {
                                popupDialog.dismiss()
                                window?.destroy()
                            } catch (_: Exception) {}
                        }
                    }
                }
                popupDialog.setContentView(popupWebView)
                popupDialog.setOnDismissListener {
                    try {
                        popupWebView.destroy()
                    } catch (_: Exception) {}
                }
                popupDialog.show()
                transport.webView = popupWebView
                resultMsg.sendToTarget()
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                if (wantsAudio) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(request.resources)
                    } else {
                        pendingPermissionRequest = request
                        audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                } else {
                    request.grant(request.resources)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                return try {
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (_: Exception) {
                    fileUploadCallback = null
                    false
                }
            }
        }

        webView.setDownloadListener { url, _, _, _, _ ->
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (getBaseUrl() == PLACEHOLDER_URL) {
            promptForServerUrl {
                handleIncomingIntent(intent, isInitialLoad = true)
            }
        } else {
            handleIncomingIntent(intent, isInitialLoad = true)
        }
    }

    private fun promptForServerUrl(onSaved: () -> Unit) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://your-worker.workers.dev"
        }
        AlertDialog.Builder(this)
            .setTitle("Configure PlacesTracker URL")
            .setMessage("Enter your deployed PlacesTracker Cloudflare Worker URL:")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Save") { _, _ ->
                val url = input.text?.toString()?.trim()?.trimEnd('/') ?: ""
                if (url.startsWith("http")) {
                    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit()
                        .putString(KEY_SERVER_URL, url)
                        .apply()
                }
                onSaved()
            }
            .show()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent, isInitialLoad = false)
    }

    private fun handleIncomingIntent(intent: Intent?, isInitialLoad: Boolean) {
        val base = getBaseUrl()
        val sharedText = extractSharedText(intent)
        if (!sharedText.isNullOrBlank()) {
            val encoded = URLEncoder.encode(sharedText.trim(), "UTF-8")
            webView.loadUrl("$base/?text=$encoded")
            return
        }

        val dataUri = intent?.data
        if (dataUri != null && dataUri.scheme == "placestracker") {
            val query = dataUri.encodedQuery
            val target = if (!query.isNullOrBlank()) "$base/?$query" else base
            webView.loadUrl(target)
            return
        }

        if (isInitialLoad) {
            webView.loadUrl(base)
        }
    }

    private fun extractSharedText(intent: Intent?): String? {
        if (intent == null) return null
        if (intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
            return listOf(subject, text).filter { it.isNotBlank() }.joinToString(" - ")
        }
        return null
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
