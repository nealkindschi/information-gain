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

    // Enriched text contains only modified paragraphs, each with [IG src="..."]...[/IG] markers.
    var paragraphs = data.enriched.split(/\n\n+/).filter(function (p) { return p.trim(); });
    var enrichedParagraphs = [];
    for (var i = 0; i < paragraphs.length; i++) {
      if (/\[IG\s/.test(paragraphs[i])) {
        enrichedParagraphs.push(paragraphs[i].trim());
      }
    }

    if (enrichedParagraphs.length === 0) {
      resultsArea.innerHTML =
        '<div class="bg-cream-100 dark:bg-warm-850 border border-cream-400 dark:border-warm-800 rounded-lg p-6 text-center">' +
        '<p class="text-warm-700 dark:text-cream-300">No enrichment opportunities found in this article.</p>' +
        '</div>';
      return;
    }

    var cardsHtml = "";

    for (var i = 0; i < enrichedParagraphs.length; i++) {
      var enrichedPara = enrichedParagraphs[i];

      // Parse [IG src="path"]content[/IG]
      var regex = /\[IG\s+src="([^"]*)"\]([\s\S]*?)\[\/IG\]/g;
      var match = regex.exec(enrichedPara);
      if (!match) continue;

      var sourceFile = match[1];
      var injectionContent = match[2].trim();

      // Look up category from data.injections (best effort)
      var category = "data";
      for (var j = 0; j < data.injections.length; j++) {
        var inj = data.injections[j];
        if (inj && injectionContent.indexOf(inj.fact.substring(0, 30)) !== -1) {
          category = (inj.category || "data").replace(/_/g, " ");
          break;
        }
      }

      // Build source link from the marker's src attribute
      var sourceLabel = sourceFile.replace(/^\/reports\//, "").replace(/\.(pdf|md)$/, "");
      var sourceLink =
        '<a href="' + escapeHtml(sourceFile) + '" target="_blank" rel="noopener" class="change-card-source">&Nearr; ' + escapeHtml(sourceLabel) + '</a>';

      // Original: strip all [IG src="..."]...[/IG] markers
      var originalText = enrichedPara.replace(/\[IG\s+src="[^"]*"\][\s\S]*?\[\/IG\]/g, "");

      // Enriched: convert [IG src="..."]...[/IG] to highlighted mark
      var enrichedHtml = enrichedPara.replace(
        /\[IG\s+src="[^"]*"\]([\s\S]*?)\[\/IG\]/g,
        '<mark class="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">' + escapeHtml(injectionContent) + '</mark>'
      );

      cardsHtml +=
        '<div class="change-card">' +
        '<div class="change-card-header">' +
        '<span class="change-card-category">' + escapeHtml(category) + '</span>' +
        '<span class="change-card-num">' + (i + 1) + ' of ' + enrichedParagraphs.length + '</span>' +
        '</div>' +
        '<div class="grid grid-cols-1 md:grid-cols-2">' +
        '<div class="change-card-col change-card-original">' +
        '<div class="change-card-label">Original</div>' +
        '<div class="change-card-text">' + escapeHtml(originalText) + '</div>' +
        '</div>' +
        '<div class="change-card-col change-card-enriched">' +
        '<div class="change-card-label">Enriched</div>' +
        '<div class="change-card-text">' + enrichedHtml + '</div>' +
        '<div class="change-card-source-wrap">' + sourceLink + '</div>' +
        '</div>' +
        '</div>' +
      '</div>';
    }

    resultsArea.innerHTML =
      '<div class="changes-header">' +
      '<span class="font-semibold text-warm-800 dark:text-cream-200">' + enrichedParagraphs.length + ' change' + (enrichedParagraphs.length !== 1 ? "s" : "") + ' found</span>' +
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
