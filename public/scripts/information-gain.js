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
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showError(msg) {
    resultsArea.classList.remove("hidden");
    resultsArea.innerHTML =
      '<div class="bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg p-6 text-center">' +
      '<p class="text-red-700 dark:text-red-300 font-medium">' + escapeHtml(msg) + '</p>' +
      '<button onclick="this.parentElement.parentElement.classList.add(\'hidden\')" class="mt-4 text-sm text-red-600 dark:text-red-400 underline">Dismiss</button>' +
      '</div>';
  }

  function renderResults(data) {
    resultsArea.classList.remove("hidden");

    // Find all [IG src="..."]...[/IG] markers in the full enriched text
    var regex = /\[IG\s+src="([^"]*)"\]([\s\S]*?)\[\/IG\]/g;
    var matches = [];
    var m;
    while ((m = regex.exec(data.enriched)) !== null) {
      matches.push({
        sourceFile: m[1],
        content: m[2].trim(),
        start: m.index,
        end: m.index + m[0].length,
      });
    }

    if (matches.length === 0) {
      resultsArea.innerHTML =
        '<div class="bg-cream-100 dark:bg-warm-850 border border-cream-400 dark:border-warm-800 rounded-lg p-6 text-center">' +
        '<p class="text-warm-700 dark:text-cream-300">No enrichment opportunities found in this article.</p>' +
        '</div>';
      return;
    }

    var CONTEXT = 150;
    var cardsHtml = "";
    var enrichedText = data.enriched;

    for (var i = 0; i < matches.length; i++) {
      var match = matches[i];

      // Extract 150 chars context before and after the injection
      var ctxStart = Math.max(0, match.start - CONTEXT);
      var ctxEnd = Math.min(enrichedText.length, match.end + CONTEXT);

      var before = enrichedText.substring(ctxStart, match.start);
      var injection = match.content;
      var after = enrichedText.substring(match.end, ctxEnd);

      // Clean [IG] markers from context (in case another injection overlaps)
      var cleanBefore = before.replace(/\[IG\s+src="[^"]*"\][\s\S]*?\[\/IG\]/g, "");
      var cleanAfter = after.replace(/\[IG\s+src="[^"]*"\][\s\S]*?\[\/IG\]/g, "");

      var ellipsisStart = ctxStart > 0 ? "&hellip; " : "";
      var ellipsisEnd = ctxEnd < enrichedText.length ? " &hellip;" : "";

      // Original: context without the injection
      var originalExcerpt = ellipsisStart + escapeHtml(cleanBefore + cleanAfter) + ellipsisEnd;

      // Enriched: context with highlighted injection (strip neighbor IG markers from view)
      var enrichedExcerpt = ellipsisStart +
        escapeHtml(cleanBefore) +
        '<mark class="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">' + escapeHtml(injection) + '</mark>' +
        escapeHtml(cleanAfter) +
        ellipsisEnd;

      // Look up report title from data.injections (best effort)
      var reportTitle = match.sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, "");
      for (var j = 0; j < data.injections.length; j++) {
        var inj = data.injections[j];
        if (inj && injection.indexOf(inj.fact.substring(0, 30)) !== -1) {
          if (inj.reportTitle) reportTitle = inj.reportTitle;
          break;
        }
      }

      // Build source link from the marker's src attribute
      var sourceLink =
        '<a href="' + escapeHtml(match.sourceFile) + '" target="_blank" rel="noopener" class="change-card-source">\u2197 ' + escapeHtml(reportTitle) + '</a>';

      cardsHtml +=
        '<div class="change-card">' +
        '<div class="change-card-header">' +
        '<span class="change-card-num">Change ' + (i + 1) + ' of ' + matches.length + '</span>' +
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
      '<span class="font-semibold text-warm-800 dark:text-cream-200">' + matches.length + ' change' + (matches.length !== 1 ? "s" : "") + ' found</span>' +
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
        // Log raw response for debugging
        var contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return response.text().then(function (raw) {
            throw new Error("Non-JSON response (" + response.status + "): " + raw.substring(0, 200));
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
        console.error("Fetch error:", err);
        showError("Network error: " + (err.message || "Please check your connection and try again."));
      })
      .finally(function () {
        runBtn.disabled = false;
        runBtn.textContent = "Run Enrichment \u2192";
        clearProgress();
      });
  });
})();
