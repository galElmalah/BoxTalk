import { getToken, setToken, status } from "./bridge.js";

const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("save-status");

(async function init() {
  const existing = await getToken();
  if (existing) tokenInput.value = existing;
})();

saveBtn.addEventListener("click", async () => {
  saveStatus.className = "";
  saveStatus.textContent = "";
  const token = (tokenInput.value || "").trim();
  if (!token) {
    saveStatus.className = "err";
    saveStatus.textContent = "Token cannot be empty.";
    return;
  }
  await setToken(token);
  const s = await status();
  if (!s.ok) {
    saveStatus.className = "err";
    saveStatus.textContent = `Saved, but BoxTalk seems unreachable (${s.reason}).`;
    return;
  }
  saveStatus.className = "ok";
  saveStatus.textContent = "Saved.";
});
