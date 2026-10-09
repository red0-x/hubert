#!/usr/bin/env python3
"""Hubert's own desktop window: GTK4 + WebKitGTK (system libs, no browser, no new deps)."""
import os, sys, gi
gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gtk, WebKit, Gio, GLib

URL = f"http://127.0.0.1:{os.environ.get('HUBERT_PORT', '7777')}"
APP_ID = "dev.hubert.Hubert"

class Hubert(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
        GLib.set_prgname(APP_ID)
        self.win = None

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
        # Only our own origin may use the mic.
        view.connect("permission-request", self.on_permission)
        # Anything that leaves the app opens in the system default handler, not in here.
        view.connect("decide-policy", self.on_policy)
        view.load_uri(URL)
        self.win = Gtk.ApplicationWindow(application=self, title="Hubert", default_width=1280, default_height=820)
        self.win.set_child(view)
        self.win.present()

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
