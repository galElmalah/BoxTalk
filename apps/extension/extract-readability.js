// Content script: runs Mozilla Readability on a clone of the live document
// and sends the extracted article back to the popup. Loaded together with
// vendor/Readability.js via chrome.scripting.executeScript({ files: [...] }).
//
// IIFE so a second injection on the same page doesn't redeclare anything.

(() => {
  function send(payload) {
    try {
      chrome.runtime.sendMessage({ type: "boxtalk:extracted", payload });
    } catch (err) {
      // The popup may have closed before we replied — nothing to do.
      console.warn("[boxtalk] could not post extracted text:", err?.message);
    }
  }

  try {
    if (typeof Readability !== "function") {
      send({ ok: false, error: "Readability library not loaded" });
      return;
    }
    // Readability mutates the DOM it parses, so always clone first.
    const cloned = document.cloneNode(true);
    const article = new Readability(cloned).parse();
    if (!article) {
      send({ ok: false, error: "No article content detected on this page" });
      return;
    }
    send({
      ok: true,
      title: article.title || "",
      text: article.textContent || "",
    });
  } catch (err) {
    send({ ok: false, error: err?.message || String(err) });
  }
})();
