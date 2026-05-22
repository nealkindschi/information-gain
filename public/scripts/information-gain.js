(function () {
  // Turnstile error callback — catch widget failures
  window.onTurnstileError = function (code) {
    var err = document.getElementById("enrich-form");
    var box = document.createElement("div");
    box.className = "bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg p-3 mt-3 text-center";
    box.innerHTML = '<p class="text-red-700 dark:text-red-300 font-medium text-xs">Turnstile error: ' + code + '</p>';
    err.appendChild(box);
  };

  const form = document.getElementById("enrich-form");
  const runBtn = document.getElementById("run-btn");
  const urlInput = document.getElementById("article-url");
  const progressArea = document.getElementById("progress-area");
  const progressList = document.getElementById("progress-list");
  const resultsArea = document.getElementById("results-area");

  function addProgress(msg) {
    progressArea.classList.remove("hidden");
    var el = document.createElement("div");
    el.textContent = msg;
    progressList.appendChild(el);
  }

  function clearProgress() {
    progressList.innerHTML = "";
    progressArea.classList.add("hidden");
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showError(msg) {
    resultsArea.classList.remove("hidden");
    resultsArea.innerHTML =
      '<div class="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg p-6 text-center">' +
      '<p class="text-red-700 dark:text-red-300 font-medium">' + escapeHtml(msg) + '</p>' +
      '<button onclick="this.parentElement.parentElement.classList.add(\'hidden\')" class="mt-4 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>' +
      '</div>';
  }

  function formatText(str) {
    return escapeHtml(str)
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");
  }

  function renderResults(data) {
    resultsArea.classList.remove("hidden");

    var injections = data.injections || [];
    if (injections.length === 0) {
      resultsArea.innerHTML =
        '<div class="bg-card-bg border border-card-border rounded-lg p-6 text-center">' +
        '<p class="text-warm-700 dark:text-cream-300">No enrichment opportunities found in this article.</p>' +
        '</div>';
      return;
    }

    var CONTEXT = 150;
    var enrichedText = data.enriched;
    var cardsHtml = "";

    for (var i = 0; i < injections.length; i++) {
      var inj = injections[i];

      // Locate the injection in enriched text by position
      var start = inj.position;
      var end = start + ('[IG src="' + inj.sourceFile + '"]' + inj.fact + '[/IG]').length;

      var ctxStart = Math.max(0, start - CONTEXT);
      var ctxEnd = Math.min(enrichedText.length, end + CONTEXT);

      var before = enrichedText.substring(ctxStart, start);
      var after = enrichedText.substring(end, ctxEnd);

      // Clean overlapping IG markers from context
      var cleanBefore = before.replace(/\[IG\s+src="[^"]*"\][\s\S]*?\[\/IG\]/g, "");
      var cleanAfter = after.replace(/\[IG\s+src="[^"]*"\][\s\S]*?\[\/IG\]/g, "");

      var ellipsisStart = ctxStart > 0 ? "&hellip; " : "";
      var ellipsisEnd = ctxEnd < enrichedText.length ? " &hellip;" : "";

      var originalExcerpt = ellipsisStart + formatText(cleanBefore + cleanAfter) + ellipsisEnd;

      var enrichedExcerpt = ellipsisStart +
        formatText(cleanBefore) +
        '<mark class="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">' + formatText(inj.fact) + '</mark>' +
        formatText(cleanAfter) +
        ellipsisEnd;

      var sourceLink =
        '<a href="' + escapeHtml(inj.sourceFile) + '" target="_blank" rel="noopener" class="change-card-source">\u2197 ' + escapeHtml(inj.reportTitle) + '</a>';

      cardsHtml +=
        '<div class="change-card">' +
        '<div class="change-card-header">' +
        '<span class="change-card-num">Change ' + (i + 1) + ' of ' + injections.length + '</span>' +
        '</div>' +
        '<div class="grid grid-cols-1 md:grid-cols-2">' +
        '<div class="change-card-col change-card-original">' +
        '<div class="change-card-label">Original</div>' +
        '<div class="change-card-text">' + originalExcerpt + '</div>' +
        '</div>' +
        '<div class="change-card-col change-card-enriched">' +
        '<div class="change-card-label">Enriched</div>' +
        '<div class="change-card-text">' + enrichedExcerpt + '</div>' +
        '<div class="change-card-source-wrap">' + sourceLink + '</div>' +
        '</div>' +
        '</div>' +
      '</div>';
    }

    resultsArea.innerHTML =
      '<div class="changes-header">' +
      '<span class="changes-header-label">' + injections.length + ' change' + (injections.length !== 1 ? "s" : "") + '</span>' +
      '</div>' +
      cardsHtml;
  }

  runBtn.addEventListener("click", function () {
    var url = urlInput.value.trim();

    if (!url) {
      showError("Please enter an article URL.");
      return;
    }

    try {
      new URL(url);
    } catch (_) {
      showError("Please enter a valid URL (e.g. https://example.com/article).");
      return;
    }

    var turnstileEl = document.querySelector('[name="cf-turnstile-response"]');
    var turnstileToken = turnstileEl ? turnstileEl.value : "";

    if (!turnstileToken) {
      showError("Please complete the verification challenge.");
      return;
    }

    clearProgress();
    resultsArea.classList.add("hidden");
    runBtn.disabled = true;
    runBtn.textContent = "Processing...";

    addProgress("Sending request...");

    fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url,
        turnstileToken: turnstileToken,
      }),
    })
      .then(function (response) {
        var contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return response.text().then(function (raw) {
            var snippet = raw.substring(0, 500);
            if (
              response.status === 503 &&
              (snippet.indexOf("<!--[if lt IE 7]>") !== -1 ||
               snippet.indexOf("cf-browser-verify") !== -1 ||
               snippet.indexOf("cf_challenge") !== -1 ||
               snippet.indexOf("_cf_chl_opt") !== -1)
            ) {
              throw new Error("CF_CHALLENGE");
            }
            throw new Error("Non-JSON response (" + response.status + "): " + snippet.substring(0, 200));
          });
        }
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) {
          var errors = {
            INVALID_URL: "Could not validate that URL. Check that it's correct.",
            WORD_LIMIT: "Article exceeds the 5,000 word limit (" + result.data.wordCount + " words). Try a shorter article.",
            RATE_LIMIT: "Rate limit reached. Try again in " + (result.data.retryAfter || "an hour") + ".",
            TURNSTILE_FAILED: "Verification failed. Please refresh and try again.",
            TURNSTILE_MISSING: "Please complete the verification challenge.",
            FETCH_FAILED: "Could not fetch the article. The site may be blocking requests.",
            FETCH_TIMEOUT: "Request timed out. The article site may be slow or unreachable.",
            FETCH_BLOCKED: "Could not fetch the article. The site may be blocking automated requests.",
            FETCH_CF_BLOCKED: "The article site blocked our request (bot protection). Try a different article URL.",
            TOKEN_BUDGET: "Article is too large for enrichment. Try a shorter article.",
            ENRICH_FAILED: "The enrichment service encountered an error. Please try again.",
          };
          showError(errors[result.data.error] || "An unexpected error occurred.");
          return;
        }

        addProgress("Enrichment complete. Rendering...");
        renderResults(result.data);
      })
      .catch(function (err) {
        if (err.message === "CF_CHALLENGE") {
          showError("Cloudflare security intercepted the request. This is a known issue on pages.dev domains. Try a simpler article URL or deploy to a custom domain.");
        } else {
          showError("Fetch error: " + err.message);
        }
      });
  });
})();
