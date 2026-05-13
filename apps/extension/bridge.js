// Shared client for the BoxTalk loopback HTTP bridge. Imported as an ES
// module from the service worker (manifest sets "type": "module") and from
// popup/options scripts (loaded with <script type="module">).

const BRIDGE_URL = "http://127.0.0.1:38219";

export async function getToken() {
  const { boxtalkToken } = await chrome.storage.sync.get(["boxtalkToken"]);
  return typeof boxtalkToken === "string" && boxtalkToken ? boxtalkToken : null;
}

export async function setToken(token) {
  await chrome.storage.sync.set({ boxtalkToken: (token || "").trim() });
}

export async function status() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { method: "GET" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function post(path, body) {
  const token = await getToken();
  if (!token) {
    const err = new Error("not paired — open BoxTalk settings and paste the pairing token");
    err.code = "NOT_PAIRED";
    throw err;
  }
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BoxTalk-Token": token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const err = new Error(`bridge ${res.status}: ${errBody || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function speak({ text, source, voice }) {
  return post("/speak", { text, source, voice });
}

export function saveCandidate({ text, source, sourceUrl, title }) {
  return post("/candidates", { text, source, sourceUrl, title });
}
