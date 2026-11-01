import { getApp, getApps, initializeApp } from "firebase/app";
import { getMessaging, getToken, isSupported } from "firebase/messaging";

export type PushResult =
  | { status: "registered"; token: string }
  | {
      status:
        | "not-configured"
        | "unsupported"
        | "open-in-new-tab"
        | "denied"
        | "local-only";
    };

/** Support both clean VITE_FIREBASE_* names and legacy LOVABLE connector names. */
function env(key: string, legacyKey: string): string | undefined {
  const v = import.meta.env[key] as string | undefined;
  if (v && String(v).trim()) return String(v).trim();
  const leg = import.meta.env[legacyKey] as string | undefined;
  if (leg && String(leg).trim()) return String(leg).trim();
  return undefined;
}

const appId = env(
  "VITE_FIREBASE_APP_ID",
  "VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_APP_ID",
);
const vapidKey = env(
  "VITE_FIREBASE_VAPID_KEY",
  "VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_VAPID_KEY",
);
const firebaseConfig = {
  apiKey: env(
    "VITE_FIREBASE_API_KEY",
    "VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_WEB_API_KEY",
  ),
  projectId: env(
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_PROJECT_ID",
  ),
  appId,
  messagingSenderId:
    env("VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_MESSAGING_SENDER_ID") ??
    appId?.split(":")[1] ??
    "",
};

export function isFirebasePushConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      appId &&
      vapidKey &&
      firebaseConfig.messagingSenderId,
  );
}

/**
 * Request browser notification permission + optional FCM token.
 * If Firebase is not configured, still grants local (in-tab) alerts when permission is allowed.
 */
export async function enableTradePush(): Promise<PushResult> {
  if (!("Notification" in window)) {
    return { status: "unsupported" };
  }

  if (window.top !== window.self) {
    return { status: "open-in-new-tab" };
  }

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };

  // Local alerts work without Firebase (tab open / realtime).
  if (!isFirebasePushConfigured() || !(await isSupported())) {
    return { status: "local-only" };
  }

  try {
    const query = new URLSearchParams({
      apiKey: firebaseConfig.apiKey!,
      projectId: firebaseConfig.projectId!,
      appId: appId!,
      messagingSenderId: firebaseConfig.messagingSenderId,
    }).toString();

    const serviceWorkerRegistration = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}firebase-messaging-sw.js?${query}`,
    );
    const app = getApps().length ? getApp() : initializeApp({
      apiKey: firebaseConfig.apiKey!,
      projectId: firebaseConfig.projectId!,
      appId: appId!,
      messagingSenderId: firebaseConfig.messagingSenderId,
    });
    const token = await getToken(getMessaging(app), {
      vapidKey: vapidKey!,
      serviceWorkerRegistration,
    });

    return token ? { status: "registered", token } : { status: "local-only" };
  } catch (err) {
    console.warn("FCM registration failed, falling back to local alerts:", err);
    return { status: "local-only" };
  }
}
