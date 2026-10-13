#!/usr/bin/env python3
"""Hubert's own desktop window: GTK4 + WebKitGTK (system libs, no browser, no new deps)."""
import os, socket, sys, gi
gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gtk, WebKit, Gio, GLib, Gdk

PORT = os.environ.get("HUBERT_PORT", "7777")
URL = f"http://127.0.0.1:{PORT}"
APP_ID = "dev.hubert.Hubert"

# Shown while the server starts, so the window is on screen before the page can load.
SPLASH = (
    '<!doctype html><meta charset="utf-8"><title>hubert</title>'
    "<style>html,body{margin:0;height:100%%;display:grid;place-items:center;"
    "font:14px system-ui;background:%s;color:%s}</style><body>hubert is starting…</body>"
)


def dark_theme() -> bool:
    name = os.environ.get("GTK_THEME", "")
    if not name:
        settings = Gtk.Settings.get_default()
        if settings and settings.get_property("gtk-application-prefer-dark-theme"):
            return True
        name = str(settings.get_property("gtk-theme-name")) if settings else ""
    return "dark" in name.lower()


class Hubert(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
        GLib.set_prgname(APP_ID)
        self.win = None
        self.view = None
        self.tries = 0

    def do_activate(self):
        if self.win:  # second launch just raises the existing window
            self.win.present()
            return
        data = os.path.join(GLib.get_user_data_dir(), "hubert")
        cache = os.path.join(GLib.get_user_cache_dir(), "hubert")
        session = WebKit.NetworkSession.new(data, cache)  # persists settings/localStorage
        view = WebKit.WebView(network_session=session)
        s = view.get_settings()
        s.set_enable_media_stream(True)  # mic for voice input
        s.set_enable_developer_extras(bool(os.environ.get("HUBERT_DEVTOOLS")))
        # Startup work this app never needs: keep the GPU path, skip the rest.
        s.set_hardware_acceleration_policy(WebKit.HardwareAccelerationPolicy.ALWAYS)
        s.set_enable_smooth_scrolling(False)
        s.set_enable_page_cache(False)  # single-page app: no back/forward cache to keep
        # Match the page's own background so the first frames do not flash white.
        if dark_theme():
            view.set_background_color(Gdk.RGBA(red=0.145, green=0.145, blue=0.145, alpha=1))
            view.load_html(SPLASH % ("#252525", "#eee"), f"http://127.0.0.1:{PORT}/")
        else:
            view.set_background_color(Gdk.RGBA(red=1, green=1, blue=1, alpha=1))
            view.load_html(SPLASH % ("#ffffff", "#111"), f"http://127.0.0.1:{PORT}/")
        # Only our own origin may use the mic.
        view.connect("permission-request", self.on_permission)
        # Anything that leaves the app opens in the system default handler, not in here.
        view.connect("decide-policy", self.on_policy)
        self.view = view
        self.win = Gtk.ApplicationWindow(application=self, title="Hubert", default_width=1280, default_height=820)
        self.win.set_child(view)
        self.win.present()  # window on screen now; the page arrives when the server answers
        GLib.timeout_add(40, self.load_when_ready)

    def load_when_ready(self):
        """The splash is already visible, so wait for the server instead of loading an error page."""
        try:
            with socket.create_connection(("127.0.0.1", int(PORT)), timeout=0.25):
                pass
        except OSError:
            self.tries += 1
            if self.tries < 250:  # ~10 s, then let WebKit report whatever is wrong
                return True
        self.view.load_uri(URL)
        return False

    def on_permission(self, view, req):
        if isinstance(req, (WebKit.UserMediaPermissionRequest,)) and view.get_uri().startswith(URL):
            req.allow()
        else:
            req.deny()
        return True

    def on_policy(self, view, decision, kind):
        if kind == WebKit.PolicyDecisionType.NEW_WINDOW_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            decision.ignore()
            Gio.AppInfo.launch_default_for_uri(uri, None)
            return True
        return False


sys.exit(Hubert().run(None))
