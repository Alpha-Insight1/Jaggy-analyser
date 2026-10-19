import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bell, BellOff, Vibrate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { enableTradePush } from "@/lib/pushNotifications";
import {
  playTradeAlertSound,
  vibrateTradeAlert,
  isVibrationEnabled,
  setVibrationEnabled,
} from "@/lib/alertSound";

const STORAGE_KEY = "smc-notify-enabled";

interface TradeRow {
  id: string;
  pair: string;
  direction: string;
  confidence: number;
  entry: number;
  stop_loss: number;
  take_profit: number;
  take_profit_2: number | null;
  status: string;
  close_price: number | null;
  closed_at: string | null;
}

export const NotificationToggle = () => {
  const [enabled, setEnabled] = useState(false);
  const [vibrate, setVibrate] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const seen = useRef<Set<string>>(new Set());
  const { user } = useAuth();

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setPermission(Notification.permission);
    }
    setEnabled(localStorage.getItem(STORAGE_KEY) === "true");
    setVibrate(isVibrationEnabled());
  }, []);

  // Realtime is the in-app fallback. FCM handles delivery when the phone is locked.
  useEffect(() => {
    if (!enabled) return;

    const channel = supabase
      .channel("trades-notify")
      .on(
        "postgres_changes",
          { event: "*", schema: "public", table: "trades" },
        (payload) => {
          const t = payload.new as TradeRow;
          if (!t) return;
          const isEntry = payload.eventType === "INSERT" && t.status === "open";
           const isClosure =
             payload.eventType === "UPDATE" &&
             t.status !== "open";
          if (!isEntry && !isClosure) return;
           const eventKey = `${t.id}-${isEntry ? "entered" : `closed-${t.status}`}`;
           if (seen.current.has(eventKey)) return;
           seen.current.add(eventKey);
          const title = isEntry
            ? `Trade entered · ${t.pair} ${t.direction} · ${t.confidence}%`
            : `Trade closed · ${t.pair} ${t.status === "win" ? "profit" : "loss"}`;
          const body = isEntry
            ? `Entry ${t.entry} · SL ${t.stop_loss} · TP1 ${t.take_profit}${
                t.take_profit_2 ? ` · TP2 ${t.take_profit_2}` : ""
              }`
            : `Closed at ${t.close_price ?? "market"} · ${
                t.closed_at ? new Date(t.closed_at).toLocaleString() : "just now"
              }`;

          // Distinctive sound + optional vibration so trade entries stand
          // apart from generic toasts/system pings.
          playTradeAlertSound();
          vibrateTradeAlert();

           toast[isEntry ? "success" : t.status === "win" ? "success" : "error"](title, {
             description: body,
             duration: 8000,
           });

          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            try {
              new Notification(title, {
                body,
                tag: `${isEntry ? "signal" : "closed"}-${t.id}`,
                icon: `${import.meta.env.BASE_URL}logo.svg`,
                // Native vibrate when delivered via OS notification center
                vibrate: isVibrationEnabled() ? [80, 60, 80, 60, 220] : undefined,
              } as NotificationOptions);
            } catch {
              // Some browsers throw on certain platforms — silent fail
            }
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, user]);

  const toggle = async () => {
    if (enabled) {
      setEnabled(false);
      localStorage.setItem(STORAGE_KEY, "false");
      toast("Notifications disabled");
      return;
    }

    // Local (in-app) alerts work for any signed-in user.
    // Background phone push needs Firebase config + permission.
    try {
      const result = await enableTradePush();

      if (result.status === "denied") {
        toast.error("Notifications were denied — allow them in browser site settings");
        return;
      }
      if (result.status === "unsupported") {
        toast.error("This browser does not support notifications");
        return;
      }
      if (result.status === "open-in-new-tab") {
        toast("Open the app in its own browser tab (not an embedded preview) to enable alerts");
        return;
      }

      if (result.status === "registered" && user) {
        const { error } = await supabase.from("push_subscriptions").upsert(
          {
            user_id: user.id,
            token: result.token,
            platform: "web",
            user_agent: navigator.userAgent,
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: "user_id,token" },
        );
        if (error) {
          console.warn("Could not save push token:", error.message);
        } else {
          localStorage.setItem("jaggy-push-token", result.token);
        }
        setPermission("granted");
        setEnabled(true);
        localStorage.setItem(STORAGE_KEY, "true");
        toast.success("Alerts on — including background phone push");
        return;
      }

      // local-only or registered without user: still enable in-app alerts
      setPermission(Notification.permission);
      setEnabled(true);
      localStorage.setItem(STORAGE_KEY, "true");
      if (result.status === "local-only" || result.status === "not-configured") {
        toast.success("In-app alerts on", {
          description: "Sound + banner while the app is open. Background push needs Firebase keys in Vercel.",
          duration: 6000,
        });
      } else {
        toast.success("You'll be alerted on entries and closures");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not enable alerts");
    }
  };

  const toggleVibrate = () => {
    const next = !vibrate;
    setVibrate(next);
    setVibrationEnabled(next);
    if (next && typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate([80, 60, 80, 60, 220]);
    }
    toast(next ? "Vibration on" : "Vibration off");
  };

  const testAlert = () => {
    playTradeAlertSound();
    vibrateTradeAlert();
    toast.success("🚨 Test alert", {
      description: "This is what a new trade entry sounds like.",
      duration: 3500,
    });
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={enabled ? "default" : "outline"}
        onClick={toggle}
        className="gap-2"
        title={
          enabled
            ? `Notifications on (${permission})`
            : "Enable trade entry alerts"
        }
      >
        {enabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
        <span className="hidden sm:inline">{enabled ? "Alerts On" : "Alerts Off"}</span>
      </Button>
      {enabled && (
        <>
          <Button
            size="sm"
            variant={vibrate ? "default" : "outline"}
            onClick={toggleVibrate}
            className="px-2"
            title={vibrate ? "Vibration on" : "Vibration off"}
          >
            <Vibrate className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={testAlert}
            className="px-2 text-xs"
            title="Preview alert sound"
          >
            Test
          </Button>
        </>
      )}
    </div>
  );
};
